import {
  AgentError,
  ConfigurationError,
  ContextError,
  ConversationError,
  ERROR_MESSAGES,
  ToolRegistrationError,
  toError,
} from "../errors";
import { AgentErrorStage, AgentEventType, AgentStatus } from "../types/agent";
import type {
  AgentEvent,
  AgentEventHandler,
  AgentEventInterceptor,
  AgentOptions,
  AgentResult,
  AgentRunOptions,
} from "../types/agent";
import type {
  ContextManager,
  PreparedContext,
  TokenUsage,
} from "../types/context";
import type { ToolCallId } from "../types/ids";
import type { Message, ToolCall, UserMessage } from "../types/message";
import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelTool,
} from "../types/model";
import { ToolExecutionErrorKind } from "../types/tools";
import type {
  ToolCatalog,
  ToolDefinition,
  ToolExecutionResult,
} from "../types/tools";
import { ToolExecutionEngine } from "../tools/executor";
import type { ToolExecutionEngineOptions } from "../tools/executor";
import { createModelTools } from "../tools/model-tools";
import { validateToolDefinition } from "../tools/validation";
import { isNonEmptyString } from "../util/is-non-empty-string";
import { isRecord } from "../util/is-record";
import { omitUndefined } from "../util/omit-undefined";
import {
  appendUserMessage,
  normalizeConversation,
  validateConversation,
} from "./conversation";
import { AgentEventChannels } from "./events";
import { collectModelStream } from "./model-stream";
import type { ModelStreamResult } from "./model-stream";
import { readResponseUsage, validateModelResponse } from "./model-response";

const DEFAULT_MAX_STEPS = 32;
const FINAL_STEP_INSTRUCTION =
  "You have reached the final step of this run. Do not call any tools. Answer the user using the information already available.";

interface ToolSnapshot {
  readonly catalog: ToolCatalog;
  readonly modelTools: ModelTool[];
}

function snapshotTools(catalog: ToolCatalog): ToolSnapshot {
  const tools = new Map<string, ToolDefinition>();
  for (const tool of catalog.list()) {
    validateToolDefinition(tool);
    if (tools.has(tool.name)) {
      throw new ToolRegistrationError(
        ERROR_MESSAGES.agent.duplicateTool(tool.name),
      );
    }
    tools.set(tool.name, tool);
  }

  return {
    catalog: {
      get: (name) => tools.get(name),
      list: () => [...tools.values()],
    },
    modelTools: createModelTools(tools.values()),
  };
}

function cloneResponseForEvent(response: ModelResponse): ModelResponse {
  return omitUndefined({
    text: response.text,
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: structuredClone(call.arguments),
    })),
    usage: response.usage === undefined ? undefined : { ...response.usage },
  });
}

/**
 * Tool results are flat, primitive-only records, so a shallow copy fully
 * isolates event handlers from the result later written into conversation
 * history.
 */
function cloneToolResultForEvent(
  result: ToolExecutionResult,
): ToolExecutionResult {
  return { ...result };
}

/** Best-effort text extraction for a response captured during cancellation. */
function responseText(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  return value.text;
}

function syntheticToolResult(
  callId: ToolCallId,
  name: string,
  content: string,
  errorKind:
    ToolExecutionErrorKind.Cancelled | ToolExecutionErrorKind.Execution,
): ToolExecutionResult {
  return { callId, name, content, isError: true, errorKind, durationMs: 0 };
}

interface NormalizedAgentOptions {
  readonly maxSteps: number;
  readonly engineOptions: ToolExecutionEngineOptions;
}

function normalizeAgentOptions(options: AgentOptions): NormalizedAgentOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError(ERROR_MESSAGES.agent.optionsMustBeObject);
  }
  if (!options.model || typeof options.model.generate !== "function") {
    throw new ConfigurationError(ERROR_MESSAGES.agent.modelMustProvideGenerate);
  }
  if (
    !options.context ||
    typeof options.context.prepare !== "function" ||
    typeof options.context.observe !== "function"
  ) {
    throw new ConfigurationError(ERROR_MESSAGES.agent.contextMustProvideHooks);
  }
  if (
    !options.tools ||
    typeof options.tools.get !== "function" ||
    typeof options.tools.list !== "function"
  ) {
    throw new ConfigurationError(ERROR_MESSAGES.agent.toolsMustProvideCatalog);
  }
  if (typeof options.instructions !== "string") {
    throw new ConfigurationError(ERROR_MESSAGES.agent.instructionsMustBeString);
  }
  if (!isNonEmptyString(options.cwd)) {
    throw new ConfigurationError(ERROR_MESSAGES.agent.cwdMustBeNonEmptyString);
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new ConfigurationError(ERROR_MESSAGES.agent.onEventMustBeFunction);
  }
  if (
    options.onEventError !== undefined &&
    typeof options.onEventError !== "function"
  ) {
    throw new ConfigurationError(
      ERROR_MESSAGES.agent.onEventErrorMustBeFunction,
    );
  }
  if (
    options.interceptors !== undefined &&
    (!Array.isArray(options.interceptors) ||
      options.interceptors.some(
        (interceptor) => typeof interceptor !== "function",
      ))
  ) {
    throw new ConfigurationError(
      ERROR_MESSAGES.agent.interceptorsMustBeFunctions,
    );
  }

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new ConfigurationError(
      ERROR_MESSAGES.agent.maxStepsMustBePositiveInteger,
    );
  }

  return {
    maxSteps,
    engineOptions: omitUndefined({
      timeoutMs: options.toolTimeoutMs,
      concurrency: options.toolConcurrency,
      maxResultChars: options.maxToolResultChars,
    }),
  };
}

interface PreparedStep {
  readonly messages: Message[];
  readonly toolCallIds: Set<ToolCallId>;
  readonly system: string;
  readonly compacted: boolean;
  readonly tokensEstimated: number;
}

/**
 * Validate a context rewrite before it can reach the model. A manager may
 * compact history, but the result must still be a valid conversation with
 * every tool call paired to its results.
 */
function validatePreparedContext(
  prepared: PreparedContext,
  fallbackSystem: string,
): PreparedStep {
  if (
    !prepared ||
    !Array.isArray(prepared.messages) ||
    typeof prepared.compacted !== "boolean" ||
    typeof prepared.tokensEstimated !== "number" ||
    !Number.isFinite(prepared.tokensEstimated) ||
    prepared.tokensEstimated < 0
  ) {
    throw new ContextError(ERROR_MESSAGES.context.invalidPreparedContext);
  }
  if (prepared.system !== undefined && typeof prepared.system !== "string") {
    throw new ContextError(ERROR_MESSAGES.context.systemPromptMustBeString);
  }

  let messages: Message[];
  let toolCallIds: Set<ToolCallId>;
  try {
    messages = normalizeConversation(prepared.messages);
    toolCallIds = validateConversation(messages);
  } catch (error) {
    const failure = toError(error);
    throw new ContextError(
      ERROR_MESSAGES.context.invalidMessages(failure.message),
      { cause: failure },
    );
  }

  return {
    messages,
    toolCallIds,
    system: prepared.system ?? fallbackSystem,
    compacted: prepared.compacted,
    tokensEstimated: prepared.tokensEstimated,
  };
}

function buildRequestMessages(
  history: readonly Message[],
  system: string,
  finalStep: boolean,
): Message[] {
  // The final step is forced tool-free so the run can end with an answer
  // instead of another assistant/tool pair.
  const messages: Message[] =
    system.length > 0
      ? [{ role: "system", content: system }, ...history]
      : [...history];
  if (finalStep) appendUserMessage(messages, FINAL_STEP_INSTRUCTION);
  return messages;
}

/**
 * A provider-neutral agent loop.
 *
 * The loop owns turn sequencing and conversation invariants, not tool or
 * context policy. It only knows the Model, ToolCatalog, and ContextManager
 * contracts. Each run is stateless: pass the conversation in and use the
 * returned messages for the next run.
 *
 * Invariants:
 * - An assistant message containing tool calls is always followed by exactly
 *   one tool message per call, in call order.
 * - Malformed model output is rejected before it mutates history.
 * - Tool failures are fed back to the model as tool results, not thrown.
 * - Tools are snapshotted at run start, so mid-run catalog changes affect only
 *   the next run.
 */
export class Agent {
  readonly model: Model;
  readonly instructions: string;
  readonly tools: ToolCatalog;
  readonly context: ContextManager;
  readonly cwd: string;
  readonly maxSteps: number;
  readonly engineOptions: ToolExecutionEngineOptions;
  /** Convenience view of the constructor observer, kept for compatibility. */
  readonly onEvent: AgentEventHandler | undefined;
  readonly #events: AgentEventChannels;

  constructor(options: AgentOptions) {
    const { maxSteps, engineOptions } = normalizeAgentOptions(options);

    this.model = options.model;
    this.instructions = options.instructions;
    this.tools = options.tools;
    this.context = options.context;
    this.cwd = options.cwd;
    this.maxSteps = maxSteps;
    this.onEvent = options.onEvent;
    this.engineOptions = engineOptions;
    this.#events = new AgentEventChannels(
      options.onEventError === undefined
        ? {}
        : { onError: options.onEventError },
    );
    if (options.onEvent !== undefined) this.#events.subscribe(options.onEvent);
    for (const interceptor of options.interceptors ?? []) {
      this.#events.intercept(interceptor);
    }

    // Fail fast on invalid execution options; runs build an engine from a
    // catalog snapshot instead of this throwaway instance.
    new ToolExecutionEngine(options.tools, engineOptions);
  }

  /** Register a read-only observer. The returned function unsubscribes. */
  subscribe(handler: AgentEventHandler): () => void {
    return this.#events.subscribe(handler);
  }

  /** Register an interceptor. The returned function unsubscribes. */
  intercept(interceptor: AgentEventInterceptor): () => void {
    return this.#events.intercept(interceptor);
  }

  /**
   * Run until the model stops requesting tools, a limit is hit, or the run is
   * cancelled. A string input is appended as a user message; an array is used
   * as the existing conversation.
   *
   * Instructions are injected as the system message for each model call. The
   * conversation should therefore contain user, assistant, and tool messages,
   * not a system prompt of its own. Adjacent user messages are merged, and the
   * history is validated before any provider call.
   *
   * Each step:
   * 1. prepare and validate context,
   * 2. call the model (tool-free on the final step),
   * 3. validate the response and record usage,
   * 4. execute tool calls and append their results,
   * 5. repeat until the model answers, a limit is reached, or the run aborts.
   */
  async run(
    input: string | readonly Message[],
    options: AgentRunOptions = {},
  ): Promise<AgentResult> {
    if (typeof input !== "string" && !Array.isArray(input)) {
      throw new ConfigurationError(
        ERROR_MESSAGES.agent.inputMustBeStringOrMessages,
      );
    }
    if (!options || typeof options !== "object") {
      throw new ConfigurationError(ERROR_MESSAGES.agent.runOptionsMustBeObject);
    }
    if (
      options.onEvent !== undefined &&
      typeof options.onEvent !== "function"
    ) {
      throw new ConfigurationError(
        ERROR_MESSAGES.agent.runOnEventMustBeFunction,
      );
    }
    if (
      options.interceptors !== undefined &&
      (!Array.isArray(options.interceptors) ||
        options.interceptors.some(
          (interceptor) => typeof interceptor !== "function",
        ))
    ) {
      throw new ConfigurationError(
        ERROR_MESSAGES.agent.interceptorsMustBeFunctions,
      );
    }

    let history: Message[];
    let usedToolCallIds: Set<ToolCallId>;
    if (typeof input === "string") {
      history = [{ role: "user", content: input }];
      usedToolCallIds = new Set();
    } else {
      history = normalizeConversation(input);
      usedToolCallIds = validateConversation(history);
    }

    const signal = options.signal ?? new AbortController().signal;
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let steps = 0;
    const runObservers =
      options.onEvent === undefined ? undefined : [options.onEvent];

    const emit = (event: AgentEvent): Promise<void> =>
      this.#events.emit(event, {
        observers: runObservers,
        interceptors: options.interceptors,
      });
    const finish = async (result: AgentResult): Promise<AgentResult> => {
      await emit({
        type: AgentEventType.Stop,
        status: result.status,
        steps: result.steps,
      });
      return result;
    };
    const resultBase = (output: string) => ({
      messages: history,
      output,
      steps,
      usage,
    });
    const completed = (output: string): Promise<AgentResult> =>
      finish({ status: AgentStatus.Completed, ...resultBase(output) });
    const maxStepsReached = (output: string): Promise<AgentResult> =>
      finish({ status: AgentStatus.MaxSteps, ...resultBase(output) });
    const fail = async (
      stage: AgentErrorStage,
      error: Error,
      errorStep = steps,
    ): Promise<AgentResult> => {
      await emit({ type: AgentEventType.Error, step: errorStep, stage, error });
      return finish({
        status: AgentStatus.Error,
        stage,
        error,
        ...resultBase(error.message),
      });
    };
    const aborted = (): Promise<AgentResult> =>
      finish({
        status: AgentStatus.Aborted,
        ...resultBase(ERROR_MESSAGES.agent.runAborted),
      });
    const appendSyntheticToolResults = async (
      step: number,
      calls: readonly ToolCall[],
      content: string,
      errorKind:
        ToolExecutionErrorKind.Cancelled | ToolExecutionErrorKind.Execution,
    ): Promise<void> => {
      for (const call of calls) {
        const result = syntheticToolResult(
          call.id,
          call.name,
          content,
          errorKind,
        );
        history.push({
          role: "tool",
          toolCallId: call.id,
          content: result.content,
        });
        await emit({
          type: AgentEventType.ToolResult,
          step,
          result: cloneToolResultForEvent(result),
        });
      }
    };
    /**
     * Capture whatever a cancelled model call produced. A response that
     * arrived just before cancellation is still recorded; tool calls get
     * synthetic cancelled results so the partial conversation stays valid for
     * the next run.
     */
    const commitAbortedResponse = async (
      step: number,
      rawResponse: unknown,
      alreadyRecorded = false,
    ): Promise<AgentResult> => {
      let response: ModelResponse;
      try {
        response = validateModelResponse(rawResponse);
      } catch {
        const text = responseText(rawResponse);
        if (text === undefined || text.trim().length === 0) return aborted();
        response = { text, toolCalls: [] };
      }

      const toolCalls = response.toolCalls.filter(
        (call) => !usedToolCallIds.has(call.id),
      );
      const text = response.text ?? "";
      if (toolCalls.length === 0 && text.trim().length === 0) {
        return aborted();
      }

      const committed: ModelResponse = omitUndefined({
        text: text.length > 0 ? text : undefined,
        toolCalls,
        usage: response.usage,
      });

      if (!alreadyRecorded && committed.usage !== undefined) {
        try {
          this.context.observe(committed.usage, [...history]);
        } catch (error) {
          await emit({
            type: AgentEventType.Warning,
            step,
            stage: AgentErrorStage.Context,
            error: toError(error),
          });
        }
      }

      if (!alreadyRecorded) {
        await emit({
          type: AgentEventType.ModelResponse,
          step,
          response: cloneResponseForEvent(committed),
          partial: true,
        });
      }
      history.push({
        role: "assistant",
        ...(text.length > 0 ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      for (const call of toolCalls) usedToolCallIds.add(call.id);
      if (toolCalls.length > 0) {
        await appendSyntheticToolResults(
          step,
          toolCalls,
          ERROR_MESSAGES.tools.executionCancelled,
          ToolExecutionErrorKind.Cancelled,
        );
      }
      return aborted();
    };

    if (signal.aborted) return aborted();

    let snapshot: ToolSnapshot;
    let engine: ToolExecutionEngine;
    try {
      snapshot = snapshotTools(this.tools);
      engine = new ToolExecutionEngine(snapshot.catalog, this.engineOptions);
    } catch (error) {
      return fail(AgentErrorStage.Configuration, toError(error));
    }
    const modelTools = snapshot.modelTools;

    while (steps < this.maxSteps) {
      if (signal.aborted) return aborted();

      const step = steps + 1;
      const finalStep = step === this.maxSteps;
      await emit({ type: AgentEventType.StepStart, step });

      let stepContext: PreparedStep;
      try {
        stepContext = validatePreparedContext(
          await this.context.prepare({
            messages: [...history],
            system: this.instructions,
            signal,
          }),
          this.instructions,
        );
      } catch (error) {
        if (signal.aborted) return aborted();
        return fail(AgentErrorStage.Context, toError(error), step);
      }

      history = stepContext.messages;
      usedToolCallIds = stepContext.toolCallIds;
      await emit({
        type: AgentEventType.ContextPrepared,
        step,
        compacted: stepContext.compacted,
        tokensEstimated: stepContext.tokensEstimated,
      });

      if (signal.aborted) return aborted();

      const requestMessages = buildRequestMessages(
        history,
        stepContext.system,
        finalStep,
      );

      steps = step;
      const request: ModelRequest = {
        messages: requestMessages,
        tools: finalStep ? [] : modelTools,
        signal,
      };
      let rawResponse: ModelResponse;
      if (typeof this.model.streamText === "function") {
        let streamed: ModelStreamResult;
        try {
          streamed = await collectModelStream(
            this.model.streamText(request),
            signal,
          );
        } catch (error) {
          if (signal.aborted) return aborted();
          return fail(AgentErrorStage.Model, toError(error));
        }

        const streamedUsage = readResponseUsage(streamed.response);
        if (streamedUsage) {
          usage.inputTokens += streamedUsage.inputTokens;
          usage.outputTokens += streamedUsage.outputTokens;
        }
        if (streamed.aborted) {
          return commitAbortedResponse(step, streamed.response);
        }
        rawResponse = streamed.response;
      } else {
        try {
          rawResponse = await this.model.generate(request);
        } catch (error) {
          if (signal.aborted) return aborted();
          return fail(AgentErrorStage.Model, toError(error));
        }

        const billedUsage = readResponseUsage(rawResponse);
        if (billedUsage) {
          usage.inputTokens += billedUsage.inputTokens;
          usage.outputTokens += billedUsage.outputTokens;
        }
      }

      // A provider response that arrived before cancellation still belongs in
      // the partial transcript. Only a call that never produced a response is
      // discarded.
      if (signal.aborted) {
        return commitAbortedResponse(step, rawResponse);
      }

      let response: ModelResponse;
      try {
        response = validateModelResponse(rawResponse);
      } catch (error) {
        return fail(AgentErrorStage.Response, toError(error));
      }

      for (const call of response.toolCalls) {
        if (usedToolCallIds.has(call.id)) {
          return fail(
            AgentErrorStage.Response,
            new ConversationError(
              ERROR_MESSAGES.conversation.duplicateToolCallId(call.id),
            ),
          );
        }
      }

      if (response.usage) {
        try {
          this.context.observe(response.usage, [...history]);
        } catch (error) {
          await emit({
            type: AgentEventType.Warning,
            step,
            stage: AgentErrorStage.Context,
            error: toError(error),
          });
        }
      }

      // Cloning keeps event handlers from mutating conversation state.
      await emit({
        type: AgentEventType.ModelResponse,
        step,
        response: cloneResponseForEvent(response),
      });
      if (signal.aborted) {
        // The normal ModelResponse event was already emitted (and recorded by
        // any interceptors) before this check, so only commit the transcript.
        return commitAbortedResponse(step, response, true);
      }

      const text = response.text ?? "";
      if (response.toolCalls.length === 0) {
        history.push({
          role: "assistant",
          ...(text.length > 0 ? { content: text } : {}),
        });
        if (finalStep) {
          return maxStepsReached(text);
        }
        return completed(text);
      }

      if (finalStep) {
        await emit({
          type: AgentEventType.Warning,
          step,
          stage: AgentErrorStage.Response,
          error: new AgentError(ERROR_MESSAGES.agent.finalStepRequestedTools),
        });
        return maxStepsReached(
          text.trim().length > 0
            ? text
            : ERROR_MESSAGES.agent.maxStepsReached(this.maxSteps),
        );
      }

      for (const call of response.toolCalls) usedToolCallIds.add(call.id);
      history.push({
        role: "assistant",
        ...(text.length > 0 ? { content: text } : {}),
        toolCalls: response.toolCalls,
      });

      const deferred: UserMessage[] = [];
      let concluded = false;
      let results: ToolExecutionResult[];
      try {
        const requests = response.toolCalls.map((call) => ({
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        }));
        results = await engine.executeMany(
          requests,
          {
            cwd: this.cwd,
            signal,
            deferContext: (message) => {
              if (
                !message ||
                message.role !== "user" ||
                typeof message.content !== "string"
              ) {
                throw new AgentError(
                  ERROR_MESSAGES.agent.deferContextRequiresUserMessage,
                );
              }
              deferred.push({ role: "user", content: message.content });
            },
            concludeTurn: () => {
              concluded = true;
            },
          },
          {
            onStart: (request) =>
              emit({
                type: AgentEventType.ToolStart,
                step,
                callId: request.callId,
                name: request.name,
              }),
            onResult: (result) =>
              emit({
                type: AgentEventType.ToolResult,
                step,
                result: cloneToolResultForEvent(result),
              }),
          },
        );
      } catch (error) {
        const failure = toError(error);
        if (signal.aborted) {
          await appendSyntheticToolResults(
            step,
            response.toolCalls,
            ERROR_MESSAGES.tools.executionCancelled,
            ToolExecutionErrorKind.Cancelled,
          );
          return aborted();
        }

        await appendSyntheticToolResults(
          step,
          response.toolCalls,
          ERROR_MESSAGES.agent.toolExecutionFailed(failure.message),
          ToolExecutionErrorKind.Execution,
        );
        return fail(AgentErrorStage.Tools, failure);
      }

      // validateModelResponse guarantees unique call ids, so this map cannot
      // collapse two different calls.
      const resultsById = new Map<ToolCallId, ToolExecutionResult>();
      for (const result of results) resultsById.set(result.callId, result);
      for (const call of response.toolCalls) {
        let result = resultsById.get(call.id);
        if (!result) {
          result = syntheticToolResult(
            call.id,
            call.name,
            ERROR_MESSAGES.agent.missingToolResult,
            ToolExecutionErrorKind.Execution,
          );
          await emit({
            type: AgentEventType.ToolResult,
            step,
            result: cloneToolResultForEvent(result),
          });
        }
        history.push({
          role: "tool",
          toolCallId: call.id,
          content: result.content,
        });
      }
      for (const message of deferred)
        appendUserMessage(history, message.content);

      if (signal.aborted) return aborted();
      if (concluded) return completed(text);
    }

    return maxStepsReached(ERROR_MESSAGES.agent.maxStepsReached(this.maxSteps));
  }
}
