import {
  ERROR_MESSAGES,
  InvalidModelResponseError,
  errorMessage,
  toError,
} from "../errors";
import type { TokenUsage } from "../types/context";
import { asToolCallId } from "../types/ids";
import type { ToolCallId } from "../types/ids";
import type { ToolCall } from "../types/message";
import { ModelStreamChunkType } from "../types/model";
import type { ModelResponse, ModelStreamChunk } from "../types/model";
import { isNonEmptyString } from "../util/is-non-empty-string";
import { isRecord } from "../util/is-record";
import { omitUndefined } from "../util/omit-undefined";
import { readResponseUsage } from "./model-response";
import { parseToolCalls } from "./tool-calls";

/** Result of consuming a provider stream, including aborted prefixes. */
export interface ModelStreamResult {
  /** The response accumulated before completion or cancellation. */
  readonly response: ModelResponse;
  /** True when iteration stopped because the run was aborted. */
  readonly aborted: boolean;
}

interface PendingToolCall {
  readonly name?: string;
  /** Argument fragments in arrival order. */
  readonly arguments: string[];
}

function invalid(detail: string): never {
  throw new InvalidModelResponseError(detail);
}

/**
 * Validate one stream chunk at the provider trust boundary. Providers are
 * external code; a malformed chunk must fail the run rather than reach history.
 */
function readStreamChunk(value: unknown): ModelStreamChunk {
  if (!isRecord(value)) {
    invalid(ERROR_MESSAGES.modelResponse.streamChunkMustBeObject);
  }
  const type = value.type;
  if (typeof type !== "string") {
    invalid(ERROR_MESSAGES.modelResponse.streamChunkMustBeObject);
  }

  switch (type) {
    case ModelStreamChunkType.TextDelta:
      if (typeof value.text !== "string") {
        invalid(ERROR_MESSAGES.modelResponse.streamTextDeltaMustBeString);
      }
      return { type: ModelStreamChunkType.TextDelta, text: value.text };

    case ModelStreamChunkType.ToolCallDelta: {
      if (!isNonEmptyString(value.toolCallId)) {
        invalid(
          ERROR_MESSAGES.modelResponse.streamToolCallIdMustBeNonEmptyString,
        );
      }
      const name = value.name;
      const argumentsDelta = value.argumentsDelta;
      if (
        (name !== undefined && typeof name !== "string") ||
        (argumentsDelta !== undefined && typeof argumentsDelta !== "string")
      ) {
        invalid(ERROR_MESSAGES.modelResponse.streamToolCallDeltaMustBeString);
      }
      return omitUndefined({
        type: ModelStreamChunkType.ToolCallDelta,
        toolCallId: asToolCallId(value.toolCallId),
        name,
        argumentsDelta,
      });
    }

    case ModelStreamChunkType.ToolCallDone: {
      let call: ToolCall;
      try {
        const calls = parseToolCalls(
          [value.toolCall],
          "Model stream tool call",
        );
        const parsed = calls[0];
        if (parsed === undefined) throw new Error("missing tool call");
        call = parsed;
      } catch (error) {
        throw new InvalidModelResponseError(
          ERROR_MESSAGES.modelResponse.streamToolCallDoneInvalid,
          { cause: toError(error) },
        );
      }
      return { type: ModelStreamChunkType.ToolCallDone, toolCall: call };
    }

    case ModelStreamChunkType.Usage: {
      const usage = readResponseUsage({ usage: value.usage });
      if (usage === undefined) {
        invalid(ERROR_MESSAGES.modelResponse.streamUsageInvalid);
      }
      return { type: ModelStreamChunkType.Usage, usage };
    }

    case ModelStreamChunkType.Done:
      return { type: ModelStreamChunkType.Done };

    default:
      return invalid(ERROR_MESSAGES.modelResponse.streamChunkTypeInvalid(type));
  }
}

/**
 * Accumulates chunks without committing anything to conversation history.
 * Tool-call deltas stay pending until a `ToolCallDone` chunk or the stream ends;
 * a partial result deliberately drops unfinished calls.
 */
class StreamAccumulator {
  readonly #text: string[] = [];
  readonly #toolCalls = new Map<ToolCallId, ToolCall>();
  readonly #pending = new Map<ToolCallId, PendingToolCall>();
  #usage: TokenUsage | undefined;

  add(chunk: ModelStreamChunk): void {
    switch (chunk.type) {
      case ModelStreamChunkType.TextDelta:
        this.#text.push(chunk.text);
        break;

      case ModelStreamChunkType.ToolCallDelta: {
        const existing = this.#pending.get(chunk.toolCallId);
        const name = chunk.name ?? existing?.name;
        const argumentFragments = existing?.arguments ?? [];
        argumentFragments.push(chunk.argumentsDelta ?? "");
        this.#pending.set(
          chunk.toolCallId,
          omitUndefined({ name, arguments: argumentFragments }),
        );
        break;
      }

      case ModelStreamChunkType.ToolCallDone:
        if (this.#toolCalls.has(chunk.toolCall.id)) {
          throw new InvalidModelResponseError(
            ERROR_MESSAGES.modelResponse.streamToolCallDuplicate(
              chunk.toolCall.id,
            ),
          );
        }
        this.#pending.delete(chunk.toolCall.id);
        this.#toolCalls.set(chunk.toolCall.id, chunk.toolCall);
        break;

      case ModelStreamChunkType.Usage:
        this.#usage = { ...chunk.usage };
        break;

      case ModelStreamChunkType.Done:
        break;
    }
  }

  result(partial: boolean): ModelResponse {
    const toolCalls = [...this.#toolCalls.values()];
    // Only a finished stream can resolve a call that never sent ToolCallDone.
    if (!partial) {
      for (const [id, pending] of this.#pending) {
        if (this.#toolCalls.has(id)) continue;
        if (pending.name === undefined) {
          throw new InvalidModelResponseError(
            ERROR_MESSAGES.modelResponse.streamToolCallNameMissing(id),
          );
        }
        const serialized = pending.arguments.join("");
        let parsed: unknown = {};
        if (serialized.trim().length > 0) {
          try {
            parsed = JSON.parse(serialized);
          } catch (error) {
            throw new InvalidModelResponseError(
              ERROR_MESSAGES.modelResponse.streamToolCallArgumentsInvalid(
                id,
                errorMessage(error),
              ),
            );
          }
        }
        if (!isRecord(parsed)) {
          throw new InvalidModelResponseError(
            ERROR_MESSAGES.modelResponse.streamToolCallArgumentsInvalid(
              id,
              "arguments must decode to a plain object",
            ),
          );
        }
        toolCalls.push({ id, name: pending.name, arguments: { ...parsed } });
      }
    }

    const text = this.#text.join("");
    return omitUndefined({
      text: text.length > 0 ? text : undefined,
      toolCalls,
      usage: this.#usage === undefined ? undefined : { ...this.#usage },
    });
  }
}

function closeStream(iterator: AsyncIterator<ModelStreamChunk>): void {
  try {
    const pending = iterator.return?.();
    if (pending !== undefined) {
      void Promise.resolve(pending).catch(() => undefined);
    }
  } catch {
    // The useful failure is the one that ended iteration, not cleanup.
  }
}

/**
 * Wait for the next chunk unless cancellation wins first. The provider still
 * receives the abort signal through its request, so this race only prevents a
 * provider that ignores the signal from keeping the run alive.
 */
function nextChunk(
  iterator: AsyncIterator<ModelStreamChunk>,
  signal: AbortSignal,
): Promise<IteratorResult<ModelStreamChunk> | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve(undefined);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Consume a model stream into a response. A cancellation returns the prefix
 * accumulated so far with `aborted: true`; the caller decides how to commit it.
 */
export async function collectModelStream(
  stream: AsyncIterable<ModelStreamChunk>,
  signal: AbortSignal,
): Promise<ModelStreamResult> {
  const iterator = stream[Symbol.asyncIterator]();
  const accumulator = new StreamAccumulator();
  let aborted = false;

  try {
    while (true) {
      const next = await nextChunk(iterator, signal);
      if (next === undefined) {
        aborted = true;
        break;
      }
      if (next.done) break;

      const chunk = readStreamChunk(next.value);
      accumulator.add(chunk);
      if (chunk.type === ModelStreamChunkType.Done) {
        closeStream(iterator);
        break;
      }
    }
  } catch (error) {
    // Ensure provider generators release resources when validation or
    // accumulation fails, without allowing cleanup failures to mask the cause.
    closeStream(iterator);
    if (!signal.aborted) throw error;
    aborted = true;
  } finally {
    if (aborted) closeStream(iterator);
  }

  return { response: accumulator.result(aborted), aborted };
}
