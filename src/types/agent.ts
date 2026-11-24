import type { ContextManager, TokenUsage } from "./context";
import type { ToolCallId } from "./ids";
import type { Message } from "./message";
import type { Model, ModelResponse } from "./model";
import type { ToolCatalog, ToolExecutionResult } from "./tools";

/** Receives every event that survives interception. Errors are isolated. */
export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

/** A read-only observer; equivalent to a handler registered with `subscribe()`. */
export type AgentEventObserver = AgentEventHandler;

/**
 * An interceptor may rewrite the event by returning another `AgentEvent`, or
 * stop delivery with a block decision. Returning `undefined` passes the current
 * event to the next interceptor.
 */
export type AgentEventInterceptor = (
  event: AgentEvent,
) => AgentInterceptResult | Promise<AgentInterceptResult>;

/** A terminal interception result: later interceptors and observers are skipped. */
export interface AgentInterceptBlock {
  readonly kind: "block";
  readonly reason?: string;
}

export type AgentInterceptResult = AgentEvent | AgentInterceptBlock | void;

/** Stages at which an agent run can fail or emit a warning. */
export enum AgentErrorStage {
  Configuration = "configuration",
  Context = "context",
  Model = "model",
  Response = "response",
  Tools = "tools",
}

/** Terminal status of an agent run. */
export enum AgentStatus {
  Completed = "completed",
  MaxSteps = "max-steps",
  Aborted = "aborted",
  Error = "error",
}

/** Kinds of observability events emitted during a run. */
export enum AgentEventType {
  StepStart = "step-start",
  ContextPrepared = "context-prepared",
  ModelResponse = "model-response",
  ToolStart = "tool-start",
  ToolResult = "tool-result",
  Warning = "warning",
  Error = "error",
  Stop = "stop",
}

export interface AgentStepStartEvent {
  type: AgentEventType.StepStart;
  step: number;
}

export interface AgentContextPreparedEvent {
  type: AgentEventType.ContextPrepared;
  step: number;
  compacted: boolean;
  tokensEstimated: number;
}

export interface AgentModelResponseEvent {
  type: AgentEventType.ModelResponse;
  step: number;
  response: ModelResponse;
  /**
   * True when a cancelled run captured the response as it stood at that
   * moment. The text and tool calls may be incomplete.
   */
  partial?: boolean;
}

export interface AgentToolStartEvent {
  type: AgentEventType.ToolStart;
  step: number;
  callId: ToolCallId;
  name: string;
}

export interface AgentToolResultEvent {
  type: AgentEventType.ToolResult;
  step: number;
  result: ToolExecutionResult;
}

export interface AgentWarningEvent {
  type: AgentEventType.Warning;
  step: number;
  stage: AgentErrorStage;
  error: Error;
}

export interface AgentErrorEvent {
  type: AgentEventType.Error;
  step: number;
  stage: AgentErrorStage;
  error: Error;
}

export interface AgentStopEvent {
  type: AgentEventType.Stop;
  status: AgentStatus;
  steps: number;
}

/**
 * Observability events for a run. Handlers are best-effort: a throwing handler
 * never changes the outcome of the agent loop. Mutable payloads (model
 * responses and tool results) are copies, so handlers cannot corrupt history.
 */
export type AgentEvent =
  | AgentStepStartEvent
  | AgentContextPreparedEvent
  | AgentModelResponseEvent
  | AgentToolStartEvent
  | AgentToolResultEvent
  | AgentWarningEvent
  | AgentErrorEvent
  | AgentStopEvent;

/** Payloads indexed by discriminant, for typed dispatch tables and handlers. */
export type AgentEventMap = {
  [TType in AgentEventType]: Extract<AgentEvent, { type: TType }>;
};

/** The exact payload emitted for one event type. */
export type AgentEventOfType<TType extends AgentEventType> =
  AgentEventMap[TType];

/** A callback narrowed to a single event variant. */
export type AgentEventHandlerFor<TType extends AgentEventType> = (
  event: AgentEventOfType<TType>,
) => void | Promise<void>;

export interface AgentResultBase {
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

export interface AgentCompletedResult extends AgentResultBase {
  readonly status: AgentStatus.Completed;
}

export interface AgentMaxStepsResult extends AgentResultBase {
  readonly status: AgentStatus.MaxSteps;
}

export interface AgentAbortedResult extends AgentResultBase {
  readonly status: AgentStatus.Aborted;
}

export interface AgentFailedResult extends AgentResultBase {
  readonly status: AgentStatus.Error;
  readonly stage: AgentErrorStage;
  readonly error: Error;
}

export type AgentResult =
  | AgentCompletedResult
  | AgentMaxStepsResult
  | AgentAbortedResult
  | AgentFailedResult;

/** Result variants indexed by status, preserving the discriminated union. */
export type AgentResultMap = {
  [TStatus in AgentStatus]: Extract<AgentResult, { status: TStatus }>;
};

/** The exact result variant for one terminal status. */
export type AgentResultOfStatus<TStatus extends AgentStatus> =
  AgentResultMap[TStatus];

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
  /** Observer registered for this run only. */
  readonly onEvent?: AgentEventHandler;
  /** Interceptors registered for this run only, in execution order. */
  readonly interceptors?: readonly AgentEventInterceptor[];
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
  /** Observer for every event that survives interception. */
  readonly onEvent?: AgentEventHandler;
  /** Interceptors that may rewrite or block events, in execution order. */
  readonly interceptors?: readonly AgentEventInterceptor[];
  /**
   * Receives errors from observers and interceptor failures. Defaults to
   * `console.error`; events themselves never fail the run.
   */
  readonly onEventError?: (error: unknown) => void;
}
