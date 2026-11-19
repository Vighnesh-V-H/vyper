import {
  AgentError,
  ConfigurationError,
  ContextError,
  ConversationError,
  ERROR_MESSAGES,
  ToolRegistrationError,
  toError,
} from "../errors";
import type {
  AgentErrorStage,
  AgentEvent,
  AgentEventHandler,
  AgentOptions,
  AgentResult,
  AgentRunOptions,
} from "../types/agent";
import type { ContextManager, PreparedContext, TokenUsage } from "../types/context";
import type { Message, UserMessage } from "../types/message";
import type { Model, ModelResponse, ModelTool } from "../types/model";
import type { ToolCatalog, ToolDefinition, ToolExecutionResult } from "../types/tools";
import { ToolExecutionEngine } from "../tools/executor";
import type { ToolExecutionEngineOptions } from "../tools/executor";
import { validateToolDefinition } from "../tools/validation";
import { omitUndefined } from "../util/omit-undefined";
import {
  appendUserMessage,
  normalizeConversation,
  validateConversation,
} from "./conversation";
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
    modelTools: [...tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      inputSchema: parameters,
    })),
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
 * Tool results are flat, primitive-only records. A shallow copy fully isolates
 * event handlers from the result later written into conversation history.
 */
function cloneToolResultForEvent(result: ToolExecutionResult): ToolExecutionResult {
  return omitUndefined({
    callId: result.callId,
    name: result.name,
    content: result.content,
    isError: result.isError,
    errorKind: result.errorKind,
    durationMs: result.durationMs,
  });
}

function syntheticToolResult(
  callId: string,
  name: string,
  content: string,
  errorKind: "cancelled" | "execution",
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
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new ConfigurationError(ERROR_MESSAGES.agent.cwdMustBeNonEmptyString);
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new ConfigurationError(ERROR_MESSAGES.agent.onEventMustBeFunction);
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
  readonly toolCallIds: Set<string>;
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
  let toolCallIds: Set<string>;
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
  readonly onEvent: AgentEventHandler | undefined;

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

    // Fail fast on invalid execution options; runs build an engine from a
    // catalog snapshot instead of this throwaway instance.
    new ToolExecutionEngine(options.tools, engineOptions);
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
  async run(input: string | readonly Message[], options: AgentRunOptions = {}): Promise<AgentResult> {
    if (typeof input !== "string" && !Array.isArray(input)) {
      throw new ConfigurationError(
        ERROR_MESSAGES.agent.inputMustBeStringOrMessages,
      );
    }
    if (!options || typeof options !== "object") {
      throw new ConfigurationError(ERROR_MESSAGES.agent.runOptionsMustBeObject);
    }
    if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
      throw new ConfigurationError(
        ERROR_MESSAGES.agent.runOnEventMustBeFunction,
      );
    }

    let history: Message[];
    let usedToolCallIds: Set<string>;
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

    const eventHandler = options.onEvent ?? this.onEvent;
    const emit = (event: AgentEvent): void => {
      if (typeof eventHandler !== "function") return;
      try {
        eventHandler(event);
      } catch {
        // Observability must not change agent behavior or corrupt state.
      }
    };
    const finish = (result: AgentResult): AgentResult => {
      emit({ type: "stop", status: result.status, steps: result.steps });
      return result;
    };
    const fail = (stage: AgentErrorStage, error: Error, errorStep = steps): AgentResult => {
      const result: AgentResult = {
        status: "error",
        stage,
        error,
        messages: history,
        output: error.message,
        steps,
        usage,
      };
      emit({ type: "error", step: errorStep, stage, error });
      return finish(result);
    };
    const aborted = (): AgentResult =>
      finish({
        status: "aborted",
        messages: history,
        output: ERROR_MESSAGES.agent.runAborted,
        steps,
        usage,
      });

    if (signal.aborted) return aborted();

    let snapshot: ToolSnapshot;
    let engine: ToolExecutionEngine;
    try {
      snapshot = snapshotTools(this.tools);
      engine = new ToolExecutionEngine(snapshot.catalog, this.engineOptions);
    } catch (error) {
      return fail("configuration", toError(error));
    }
    const modelTools = snapshot.modelTools;

    while (steps < this.maxSteps) {
      if (signal.aborted) return aborted();

      const step = steps + 1;
      const finalStep = step === this.maxSteps;
      emit({ type: "step-start", step });

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
        return fail("context", toError(error), step);
      }

      history = stepContext.messages;
      usedToolCallIds = stepContext.toolCallIds;
      emit({
        type: "context-prepared",
        step,
        compacted: stepContext.compacted,
        tokensEstimated: stepContext.tokensEstimated,
      });

      if (signal.aborted) return aborted();

      const requestMessages = buildRequestMessages(history, stepContext.system, finalStep);

      steps = step;
      let rawResponse: ModelResponse;
      try {
        rawResponse = await this.model.generate({
          messages: requestMessages,
          tools: finalStep ? [] : modelTools,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return aborted();
        return fail("model", toError(error));
      }

      const billedUsage = readResponseUsage(rawResponse);
      if (billedUsage) {
        usage.inputTokens += billedUsage.inputTokens;
        usage.outputTokens += billedUsage.outputTokens;
      }

      if (signal.aborted) return aborted();

      let response: ModelResponse;
      try {
        response = validateModelResponse(rawResponse);
      } catch (error) {
        return fail("response", toError(error));
      }

      for (const call of response.toolCalls) {
        if (usedToolCallIds.has(call.id)) {
          return fail(
            "response",
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
          emit({ type: "warning", step, stage: "context", error: toError(error) });
        }
      }

      // Cloning keeps event handlers from mutating conversation state. emit()
      // already swallows handler errors, but cloning itself is best effort too.
      try {
        emit({ type: "model-response", step, response: cloneResponseForEvent(response) });
      } catch {
        // Observability must not fail the run.
      }
      if (signal.aborted) return aborted();

      const text = response.text ?? "";
      if (response.toolCalls.length === 0) {
        history.push({
          role: "assistant",
          ...(text.length > 0 ? { content: text } : {}),
        });
        if (finalStep) {
          return finish({
            status: "max-steps",
            messages: history,
            output: text,
            steps,
            usage,
          });
        }
        return finish({ status: "completed", messages: history, output: text, steps, usage });
      }

      if (finalStep) {
        emit({
          type: "warning",
          step,
          stage: "response",
          error: new AgentError(ERROR_MESSAGES.agent.finalStepRequestedTools),
        });
        return finish({
          status: "max-steps",
          messages: history,
          output:
            text.trim().length > 0
              ? text
              : ERROR_MESSAGES.agent.maxStepsReached(this.maxSteps),
          steps,
          usage,
        });
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
              if (!message || message.role !== "user" || typeof message.content !== "string") {
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
              emit({ type: "tool-start", step, callId: request.callId, name: request.name }),
            onResult: (result) =>
              emit({ type: "tool-result", step, result: cloneToolResultForEvent(result) }),
          },
        );
      } catch (error) {
        const failure = toError(error);
        if (signal.aborted) {
          for (const call of response.toolCalls) {
            const result = syntheticToolResult(
              call.id,
              call.name,
              ERROR_MESSAGES.tools.executionCancelled,
              "cancelled",
            );
            history.push({ role: "tool", toolCallId: call.id, content: result.content });
            emit({ type: "tool-result", step, result: cloneToolResultForEvent(result) });
          }
          return aborted();
        }

        const content = ERROR_MESSAGES.agent.toolExecutionFailed(failure.message);
        for (const call of response.toolCalls) {
          const result = syntheticToolResult(call.id, call.name, content, "execution");
          history.push({ role: "tool", toolCallId: call.id, content: result.content });
          emit({ type: "tool-result", step, result: cloneToolResultForEvent(result) });
        }
        return fail("tools", failure);
      }

      // validateModelResponse guarantees unique call ids, so this map cannot
      // collapse two different calls.
      const resultsById = new Map<string, ToolExecutionResult>();
      for (const result of results) resultsById.set(result.callId, result);
      for (const call of response.toolCalls) {
        let result = resultsById.get(call.id);
        if (!result) {
          result = syntheticToolResult(
            call.id,
            call.name,
            ERROR_MESSAGES.agent.missingToolResult,
            "execution",
          );
          emit({ type: "tool-result", step, result: cloneToolResultForEvent(result) });
        }
        history.push({ role: "tool", toolCallId: call.id, content: result.content });
      }
      for (const message of deferred) appendUserMessage(history, message.content);

      if (signal.aborted) return aborted();
      if (concluded) {
        return finish({ status: "completed", messages: history, output: text, steps, usage });
      }
    }

    return finish({
      status: "max-steps",
      messages: history,
      output: ERROR_MESSAGES.agent.maxStepsReached(this.maxSteps),
      steps,
      usage,
    });
  }
}
