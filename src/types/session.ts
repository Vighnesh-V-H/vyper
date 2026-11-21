import type { AgentEventHandler, AgentResult, AgentRunOptions } from "./agent";
import { AgentErrorStage, AgentStatus } from "./agent";
import type { TokenUsage } from "./context";
import type { EventLog, EventLogHandle } from "./event-log";
import type { SessionId, ToolCallId, TurnId } from "./ids";
import type { JsonObject } from "./json-schema";
import type { Message } from "./message";
import type { ToolExecutionResult } from "./tools";

export type { SessionId, ToolCallId, TurnId } from "./ids";

/**
 * The narrow agent contract a chat session needs.
 *
 * `onEvent` is optional so a session can preserve an application-level
 * observer while also recording the run. The agent itself remains unaware of
 * how or where the session persists anything.
 */
export interface ChatAgent {
  readonly onEvent?: AgentEventHandler;
  run(
    input: string | readonly Message[],
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
}

/** Persisted, JSON-safe description of a thrown error. */
export interface SessionErrorInfo {
  readonly name: string;
  readonly message: string;
  /** Stable vyper error code, when the error carries one. */
  readonly code?: string;
  /** Bounded cause chain; deeper cycles are discarded. */
  readonly cause?: SessionErrorInfo;
}

/**
 * A model response exactly as stored. Tool arguments have crossed the codec's
 * JSON-safety boundary, so they are `JsonObject` here even though in-memory
 * agent events deliberately keep `Record<string, unknown>`.
 */
export interface PersistedToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface PersistedModelResponse {
  readonly text?: string;
  readonly toolCalls: readonly PersistedToolCall[];
  readonly usage?: TokenUsage;
}

/** Mutable session configuration captured by the header and MetadataChanged. */
export interface SessionMetadata {
  readonly model: string;
  readonly instructions?: string;
  readonly cwd: string;
  readonly appConfig?: JsonObject;
}

/**
 * Session identity and starting configuration. A header is always persisted as
 * sequence 1 and is never rewritten; later changes append MetadataChanged.
 */
export interface SessionHeader extends SessionMetadata {
  readonly sessionId: SessionId;
  readonly version: number;
  /** Unix epoch milliseconds assigned when the stream was opened. */
  readonly timestamp: number;
}

/** Kinds of records written to a session's append-only log. */
export enum SessionEventType {
  Header = "session-header",
  MetadataChanged = "metadata-changed",
  TurnStarted = "turn-started",
  StepStarted = "step-started",
  ContextPrepared = "context-prepared",
  ModelResponded = "model-responded",
  ToolStarted = "tool-started",
  ToolCompleted = "tool-completed",
  Warning = "warning",
  Error = "error",
  TurnFinished = "turn-finished",
  Compaction = "compaction",
  Retraction = "retraction",
  Reset = "session-reset",
}

export interface SessionHeaderEvent extends SessionHeader {
  readonly type: SessionEventType.Header;
}

/** Mid-session configuration changes; the original header is never touched. */
export interface SessionMetadataChangedEvent {
  readonly type: SessionEventType.MetadataChanged;
  readonly model?: string;
  readonly instructions?: string;
  readonly cwd?: string;
  readonly appConfig?: JsonObject;
}

/** Shorthand used in design notes for the mid-session metadata event. */
export type MetadataChanged = SessionMetadataChangedEvent;

export interface SessionTurnStartedEvent {
  readonly type: SessionEventType.TurnStarted;
  readonly turnId: TurnId;
  /** The exact user prompt submitted for the turn. */
  readonly prompt: string;
}

export interface SessionStepStartedEvent {
  readonly type: SessionEventType.StepStarted;
  readonly turnId: TurnId;
  readonly step: number;
}

export interface SessionContextPreparedEvent {
  readonly type: SessionEventType.ContextPrepared;
  readonly turnId: TurnId;
  readonly step: number;
  readonly compacted: boolean;
  readonly tokensEstimated: number;
}

export interface SessionModelRespondedEvent {
  readonly type: SessionEventType.ModelResponded;
  readonly turnId: TurnId;
  readonly step: number;
  readonly response: PersistedModelResponse;
}

export interface SessionToolStartedEvent {
  readonly type: SessionEventType.ToolStarted;
  readonly turnId: TurnId;
  readonly step: number;
  readonly callId: ToolCallId;
  readonly name: string;
}

export interface SessionToolCompletedEvent {
  readonly type: SessionEventType.ToolCompleted;
  readonly turnId: TurnId;
  readonly step: number;
  readonly result: ToolExecutionResult;
}

export interface SessionWarningEvent {
  readonly type: SessionEventType.Warning;
  readonly turnId: TurnId;
  readonly step: number;
  readonly stage: AgentErrorStage;
  readonly error: SessionErrorInfo;
}

export interface SessionErrorEvent {
  readonly type: SessionEventType.Error;
  readonly turnId: TurnId;
  readonly step: number;
  readonly stage: AgentErrorStage;
  readonly error: SessionErrorInfo;
}

interface SessionTurnFinishedBase {
  readonly type: SessionEventType.TurnFinished;
  readonly turnId: TurnId;
  /**
   * Derived from the turn's ModelResponded events. The log rejects an append
   * when any of these values disagree with what was already recorded.
   */
  readonly output: string;
  readonly steps: number;
  readonly usage: TokenUsage;
}

/** Completed and max-steps turns commit the resulting conversation snapshot. */
export interface SessionTurnCommittedEvent extends SessionTurnFinishedBase {
  readonly status: AgentStatus.Completed | AgentStatus.MaxSteps;
  readonly messages: readonly Message[];
}

/** Aborted turns keep the previously committed conversation. */
export interface SessionTurnAbortedEvent extends SessionTurnFinishedBase {
  readonly status: AgentStatus.Aborted;
}

export type SessionTurnFinishedEvent =
  SessionTurnCommittedEvent | SessionTurnAbortedEvent;

/**
 * A failed or retried turn is removed from projection, not deleted from
 * storage. `retractsSequence` may point at any event belonging to the turn;
 * replay excludes that whole turn.
 */
export interface SessionRetractionEvent {
  readonly type: SessionEventType.Retraction;
  readonly retractsSequence: number;
  readonly reason: string;
}

/** Shorthand used in design notes for a retracted turn. */
export type Retraction = SessionRetractionEvent;

/**
 * A durable summary plus the sequence it replaces. Replay discards projection
 * state through `cutoffSequence`, then applies the summary and later events.
 * V1 does not emit compaction entries unless a context manager triggers one.
 */
export interface CompactionEntry {
  readonly type: SessionEventType.Compaction;
  readonly summary: string;
  readonly cutoffSequence: number;
  readonly tokensBefore: number;
  /** Unix epoch milliseconds when compaction was recorded. */
  readonly at: number;
}

export interface SessionResetEvent {
  readonly type: SessionEventType.Reset;
}

/**
 * Everything a session records. The union is deliberately closed: replay can
 * exhaustively distinguish every record, and adapters decode it at the trust
 * boundary rather than casting JSON.
 */
export type SessionEvent =
  | SessionHeaderEvent
  | SessionMetadataChangedEvent
  | SessionTurnStartedEvent
  | SessionStepStartedEvent
  | SessionContextPreparedEvent
  | SessionModelRespondedEvent
  | SessionToolStartedEvent
  | SessionToolCompletedEvent
  | SessionWarningEvent
  | SessionErrorEvent
  | SessionTurnFinishedEvent
  | CompactionEntry
  | SessionRetractionEvent
  | SessionResetEvent;

/** Payloads indexed by discriminant, for typed dispatch tables and handlers. */
export type SessionEventMap = {
  [TType in SessionEventType]: Extract<SessionEvent, { type: TType }>;
};

/** The exact payload emitted for one session event type. */
export type SessionEventOfType<TType extends SessionEventType> =
  SessionEventMap[TType];

/** A callback narrowed to a single event variant. */
export type SessionEventHandlerFor<TType extends SessionEventType> = (
  event: SessionEventOfType<TType>,
) => void;

/** State reconstructed from a durable session log. */
export interface SessionSnapshot {
  readonly sessionId: SessionId;
  /** Present for every stream opened by the session log. */
  readonly header?: SessionHeader;
  /** Effective metadata after applying MetadataChanged records. */
  readonly metadata?: SessionMetadata;
  /** Latest compaction summary, when the stream has been compacted. */
  readonly summary?: string;
  /** Sequence replaced by the latest compaction entry. */
  readonly cutoffSequence?: number;
  /** Last committed conversation. Interrupted/retracted turns are excluded. */
  readonly messages: readonly Message[];
  /** Set when the log ends between TurnStarted and TurnFinished. */
  readonly interruptedTurnId?: TurnId;
  /** Highest durable sequence number observed. */
  readonly lastSequence: number;
}

export type SessionEventLog = EventLog<SessionEvent>;
export type SessionEventLogHandle = EventLogHandle<SessionEvent>;
