import type { ContextManager, TokenUsage } from "./context";
import type { Message } from "./message";
import type { Model, ModelResponse } from "./model";
import type { ToolCatalog, ToolExecutionResult } from "./tools";

export type AgentEventHandler = (event: AgentEvent) => void;

export type AgentErrorStage =
  | "configuration"
  | "context"
  | "model"
  | "response"
  | "tools";

/**
 * Observability events for a run. Handlers are best-effort: a throwing handler
 * never changes the outcome of the agent loop. Mutable payloads (model
 * responses and tool results) are copies, so handlers cannot corrupt history.
 */
export type AgentEvent =
  | { type: "step-start"; step: number }
  | {
      type: "context-prepared";
      step: number;
      compacted: boolean;
      tokensEstimated: number;
    }
  | { type: "model-response"; step: number; response: ModelResponse }
  | { type: "tool-start"; step: number; callId: string; name: string }
  | { type: "tool-result"; step: number; result: ToolExecutionResult }
  | { type: "warning"; step: number; stage: AgentErrorStage; error: Error }
  | { type: "error"; step: number; stage: AgentErrorStage; error: Error }
  | { type: "stop"; status: AgentResult["status"]; steps: number };

interface AgentResultBase {
  /** Conversation after the run. Always valid: every tool call has a result. */
  readonly messages: readonly Message[];
  /**
   * Final assistant text. A max-steps run may still contain a real final answer
   * from the forced tool-free step; otherwise it contains a diagnostic.
   */
  readonly output: string;
  /** Number of model calls started. A failed or rejected call still counts. */
  readonly steps: number;
  /** Accumulated provider-reported usage. */
  readonly usage: TokenUsage;
}

export type AgentResult =
  | ({ readonly status: "completed" } & AgentResultBase)
  | ({ readonly status: "max-steps" } & AgentResultBase)
  | ({ readonly status: "aborted" } & AgentResultBase)
  | ({
      readonly status: "error";
      readonly stage: AgentErrorStage;
      readonly error: Error;
    } & AgentResultBase);

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
  /** Per-run override for the agent-level event handler. */
  readonly onEvent?: AgentEventHandler;
}

export interface AgentOptions {
  readonly model: Model;
  /** Static system instructions. A ContextManager may replace this per call. */
  readonly instructions: string;
  readonly tools: ToolCatalog;
  readonly context: ContextManager;
  readonly cwd: string;
  /**
   * Maximum model calls per run. The final call is forced tool-free so the run
   * can end with an answer. Defaults to 32.
   */
  readonly maxSteps?: number;
  /** Maximum tool calls executed concurrently. Defaults to 1 (sequential). */
  readonly toolConcurrency?: number;
  /** Per-tool-call timeout. Undefined means no engine-level timeout. */
  readonly toolTimeoutMs?: number;
  /** Safety cap for tool output placed in the conversation. Defaults to 100k characters. */
  readonly maxToolResultChars?: number;
  readonly onEvent?: AgentEventHandler;
}
