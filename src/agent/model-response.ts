import type { TokenUsage } from "../types/context";
import type { ToolCall } from "../types/message";
import type { ModelResponse } from "../types/model";
import { isRecord } from "../util/is-record";
import { omitUndefined } from "../util/omit-undefined";
import { InvalidToolCallsError, parseToolCalls } from "./tool-calls";

export class InvalidModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelResponseError";
  }
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value) || !isTokenCount(value.inputTokens) || !isTokenCount(value.outputTokens)) {
    return undefined;
  }
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}

/**
 * Best-effort usage extraction for responses that may fail validation or arrive
 * just as the run is cancelled. Tokens can still be billed in either case.
 */
export function readResponseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return parseTokenUsage(value.usage);
}

/**
 * Validate and normalize a provider response before it can enter history.
 * Provider adapters are a trust boundary: a malformed response must not leave
 * a half-written assistant/tool pair in the conversation.
 */
export function validateModelResponse(value: unknown): ModelResponse {
  if (!isRecord(value)) throw new InvalidModelResponseError("Model response must be an object");

  const { text, toolCalls: rawToolCalls, usage } = value;
  if (text !== undefined && typeof text !== "string") {
    throw new InvalidModelResponseError("Model response text must be a string when present");
  }

  let toolCalls: ToolCall[];
  try {
    toolCalls = parseToolCalls(rawToolCalls, "Model response toolCalls");
  } catch (error) {
    if (error instanceof InvalidToolCallsError) {
      throw new InvalidModelResponseError(error.message);
    }
    throw error;
  }
  if (toolCalls.length === 0 && (text === undefined || text.trim().length === 0)) {
    throw new InvalidModelResponseError("Model response must contain text or tool calls");
  }

  let parsedUsage: TokenUsage | undefined;
  if (usage !== undefined) {
    parsedUsage = parseTokenUsage(usage);
    if (!parsedUsage) {
      throw new InvalidModelResponseError(
        "Model response usage must contain non-negative inputTokens and outputTokens",
      );
    }
  }

  return omitUndefined({
    text,
    toolCalls,
    usage: parsedUsage,
  });
}
