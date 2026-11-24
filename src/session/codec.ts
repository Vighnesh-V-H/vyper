import { ERROR_MESSAGES, EventLogError } from "../errors";
import type { EventLogCodec } from "../types/event-log";
import type { SessionEvent } from "../types/session";
import type {
  CompactionEntry,
  PersistedModelResponse,
  PersistedToolCall,
  SessionErrorEvent,
  SessionErrorInfo,
  SessionEventMap,
  SessionHeaderEvent,
  SessionMetadataChangedEvent,
  SessionModelRespondedEvent,
  SessionResetEvent,
  SessionRetractionEvent,
  SessionStepStartedEvent,
  SessionContextPreparedEvent,
  SessionToolCompletedEvent,
  SessionToolStartedEvent,
  SessionTurnCommittedEvent,
  SessionTurnFinishedEvent,
  SessionTurnStartedEvent,
  SessionWarningEvent,
} from "../types/session";
import { SessionEventType } from "../types/session";
import { AgentErrorStage, AgentStatus } from "../types/agent";
import type { TokenUsage } from "../types/context";
import { asSessionId, asToolCallId, asTurnId } from "../types/ids";
import type { JsonObject, JsonValue } from "../types/json-schema";
import type { Message } from "../types/message";
import type { ModelResponse } from "../types/model";
import { ToolExecutionErrorKind } from "../types/tools";
import type { ToolExecutionResult } from "../types/tools";
import { omitUndefined } from "../util/omit-undefined";

const MAX_ERROR_CAUSE_DEPTH = 8;

function invalid(label: string, expected: string): never {
  throw new EventLogError(
    ERROR_MESSAGES.eventLog.invalidRecord(`${label} ${expected}`),
  );
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label, "must be an object");
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "must be a string");
  return value;
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(label, "must be a non-empty string");
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label, "must be a boolean");
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(label, "must be a finite number");
  }
  return value;
}

function expectNonNegativeNumber(value: unknown, label: string): number {
  const number = expectNumber(value, label);
  if (number < 0) invalid(label, "must be non-negative");
  return number;
}

function expectNonNegativeInteger(value: unknown, label: string): number {
  const number = expectNonNegativeNumber(value, label);
  if (!Number.isInteger(number)) invalid(label, "must be an integer");
  return number;
}

function expectPositiveInteger(value: unknown, label: string): number {
  const number = expectNumber(value, label);
  if (!Number.isInteger(number) || number <= 0) {
    invalid(label, "must be a positive integer");
  }
  return number;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return expectString(value, `${label}.${key}`);
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return expectBoolean(value, `${label}.${key}`);
}

function readOptionalJsonObject(
  record: Record<string, unknown>,
  key: string,
  label: string,
): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return readJsonObject(value, `${label}.${key}`);
}

function readEnum<const TValue extends string>(
  value: unknown,
  values: readonly TValue[],
  label: string,
): TValue {
  if (typeof value !== "string" || !values.includes(value as TValue)) {
    invalid(label, `must be one of ${values.join(", ")}`);
  }
  return value as TValue;
}

/**
 * Validate and clone a JSON value. `undefined`, functions, symbols, bigints,
 * non-finite numbers, and cycles are rejected rather than silently dropped by
 * `JSON.stringify`.
 */
export function readJsonValue(
  value: unknown,
  label = "value",
  seen: Set<object> = new Set(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(label, "must be a finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) invalid(label, "must not contain cycles");
    seen.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value))
        invalid(`${label}[${index}]`, "must not be a hole");
      result.push(readJsonValue(value[index], `${label}[${index}]`, seen));
    }
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(label, "must be a plain JSON object");
    }
    if (seen.has(value)) invalid(label, "must not contain cycles");
    seen.add(value);
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = readJsonValue(item, `${label}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  invalid(label, "must be JSON-safe");
}

export function readJsonObject(value: unknown, label = "value"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label, "must be a JSON object");
  }
  return readJsonValue(value, label) as JsonObject;
}

function readTokenUsage(value: unknown, label: string): TokenUsage {
  const record = expectRecord(value, label);
  return {
    inputTokens: expectNonNegativeNumber(
      record.inputTokens,
      `${label}.inputTokens`,
    ),
    outputTokens: expectNonNegativeNumber(
      record.outputTokens,
      `${label}.outputTokens`,
    ),
  };
}

function readPersistedToolCall(
  value: unknown,
  label: string,
): PersistedToolCall {
  const record = expectRecord(value, label);
  return {
    id: asToolCallId(expectNonEmptyString(record.id, `${label}.id`)),
    name: expectNonEmptyString(record.name, `${label}.name`),
    arguments: readJsonObject(record.arguments, `${label}.arguments`),
  };
}

function readPersistedModelResponse(
  value: unknown,
  label: string,
): PersistedModelResponse {
  const record = expectRecord(value, label);
  const text = readOptionalString(record, "text", label);
  const toolCallsValue = record.toolCalls;
  if (!Array.isArray(toolCallsValue)) {
    invalid(`${label}.toolCalls`, "must be an array");
  }
  const toolCalls = toolCallsValue.map((call, index) =>
    readPersistedToolCall(call, `${label}.toolCalls[${index}]`),
  );
  const usageValue = record.usage;
  const usage =
    usageValue === undefined
      ? undefined
      : readTokenUsage(usageValue, `${label}.usage`);
  return omitUndefined({ text, toolCalls, usage });
}

function readErrorInfo(
  value: unknown,
  label: string,
  depth = 0,
): SessionErrorInfo {
  if (depth > MAX_ERROR_CAUSE_DEPTH) {
    invalid(label, "cause chain is too deep");
  }
  const record = expectRecord(value, label);
  const causeValue = record.cause;
  const cause =
    causeValue === undefined
      ? undefined
      : readErrorInfo(causeValue, `${label}.cause`, depth + 1);
  return omitUndefined({
    name: expectString(record.name, `${label}.name`),
    message: expectString(record.message, `${label}.message`),
    code: readOptionalString(record, "code", label),
    cause,
  });
}

function readMessage(value: unknown, label: string): Message {
  const record = expectRecord(value, label);
  const role = expectNonEmptyString(record.role, `${label}.role`);
  switch (role) {
    case "system":
      return {
        role: "system",
        content: expectString(record.content, `${label}.content`),
      };
    case "user":
      return {
        role: "user",
        content: expectString(record.content, `${label}.content`),
      };
    case "assistant": {
      const content = readOptionalString(record, "content", label);
      const callsValue = record.toolCalls;
      if (callsValue === undefined) {
        return content === undefined
          ? { role: "assistant" }
          : { role: "assistant", content };
      }
      if (!Array.isArray(callsValue)) {
        invalid(`${label}.toolCalls`, "must be an array");
      }
      const toolCalls = callsValue.map((call, index) =>
        readPersistedToolCall(call, `${label}.toolCalls[${index}]`),
      );
      return content === undefined
        ? { role: "assistant", toolCalls }
        : { role: "assistant", content, toolCalls };
    }
    case "tool":
      return {
        role: "tool",
        toolCallId: asToolCallId(
          expectNonEmptyString(record.toolCallId, `${label}.toolCallId`),
        ),
        content: expectString(record.content, `${label}.content`),
      };
    default:
      return invalid(`${label}.role`, "is invalid");
  }
}

function readMessages(value: unknown, label: string): Message[] {
  if (!Array.isArray(value)) {
    invalid(label, "must be an array");
  }
  return value.map((message, index) =>
    readMessage(message, `${label}[${index}]`),
  );
}

function readToolResult(value: unknown, label: string): ToolExecutionResult {
  const record = expectRecord(value, label);
  const errorKindValue = record.errorKind;
  const errorKind =
    errorKindValue === undefined
      ? undefined
      : readEnum(
          errorKindValue,
          [
            ToolExecutionErrorKind.UnknownTool,
            ToolExecutionErrorKind.InvalidArguments,
            ToolExecutionErrorKind.Cancelled,
            ToolExecutionErrorKind.Timeout,
            ToolExecutionErrorKind.Execution,
          ],
          `${label}.errorKind`,
        );
  return omitUndefined({
    callId: asToolCallId(
      expectNonEmptyString(record.callId, `${label}.callId`),
    ),
    name: expectNonEmptyString(record.name, `${label}.name`),
    content: expectString(record.content, `${label}.content`),
    isError: expectBoolean(record.isError, `${label}.isError`),
    errorKind,
    durationMs: expectNonNegativeNumber(
      record.durationMs,
      `${label}.durationMs`,
    ),
  });
}

function readHeader(value: unknown): SessionHeaderEvent {
  const record = expectRecord(value, "header");
  return omitUndefined({
    type: SessionEventType.Header,
    sessionId: asSessionId(
      expectNonEmptyString(record.sessionId, "header.sessionId"),
    ),
    version: expectPositiveInteger(record.version, "header.version"),
    timestamp: expectNonNegativeInteger(record.timestamp, "header.timestamp"),
    model: expectNonEmptyString(record.model, "header.model"),
    instructions: readOptionalString(record, "instructions", "header"),
    cwd: expectNonEmptyString(record.cwd, "header.cwd"),
    appConfig: readOptionalJsonObject(record, "appConfig", "header"),
  });
}

function readMetadataChanged(value: unknown): SessionMetadataChangedEvent {
  const record = expectRecord(value, "metadata");
  const event: SessionMetadataChangedEvent = omitUndefined({
    type: SessionEventType.MetadataChanged,
    model:
      record.model === undefined
        ? undefined
        : expectNonEmptyString(record.model, "metadata.model"),
    instructions: readOptionalString(record, "instructions", "metadata"),
    cwd:
      record.cwd === undefined
        ? undefined
        : expectNonEmptyString(record.cwd, "metadata.cwd"),
    appConfig: readOptionalJsonObject(record, "appConfig", "metadata"),
  });
  if (
    event.model === undefined &&
    event.instructions === undefined &&
    event.cwd === undefined &&
    event.appConfig === undefined
  ) {
    throw new EventLogError(ERROR_MESSAGES.sessionLog.metadataMustChange);
  }
  return event;
}

function readTurnStarted(
  value: Record<string, unknown>,
): SessionTurnStartedEvent {
  return {
    type: SessionEventType.TurnStarted,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    prompt: expectString(value.prompt, "event.prompt"),
  };
}

function readStepStarted(
  value: Record<string, unknown>,
): SessionStepStartedEvent {
  return {
    type: SessionEventType.StepStarted,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectPositiveInteger(value.step, "event.step"),
  };
}

function readContextPrepared(
  value: Record<string, unknown>,
): SessionContextPreparedEvent {
  return {
    type: SessionEventType.ContextPrepared,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectPositiveInteger(value.step, "event.step"),
    compacted: expectBoolean(value.compacted, "event.compacted"),
    tokensEstimated: expectNonNegativeNumber(
      value.tokensEstimated,
      "event.tokensEstimated",
    ),
  };
}

function readModelResponded(
  value: Record<string, unknown>,
): SessionModelRespondedEvent {
  return omitUndefined({
    type: SessionEventType.ModelResponded,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectPositiveInteger(value.step, "event.step"),
    response: readPersistedModelResponse(value.response, "event.response"),
    partial: readOptionalBoolean(value, "partial", "event"),
  });
}

function readToolStarted(
  value: Record<string, unknown>,
): SessionToolStartedEvent {
  return {
    type: SessionEventType.ToolStarted,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectPositiveInteger(value.step, "event.step"),
    callId: asToolCallId(expectNonEmptyString(value.callId, "event.callId")),
    name: expectNonEmptyString(value.name, "event.name"),
  };
}

function readToolCompleted(
  value: Record<string, unknown>,
): SessionToolCompletedEvent {
  return {
    type: SessionEventType.ToolCompleted,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectPositiveInteger(value.step, "event.step"),
    result: readToolResult(value.result, "event.result"),
  };
}

function readWarning(value: Record<string, unknown>): SessionWarningEvent {
  return {
    type: SessionEventType.Warning,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectNonNegativeInteger(value.step, "event.step"),
    stage: readEnum(
      value.stage,
      [
        AgentErrorStage.Configuration,
        AgentErrorStage.Context,
        AgentErrorStage.Model,
        AgentErrorStage.Response,
        AgentErrorStage.Tools,
      ],
      "event.stage",
    ),
    error: readErrorInfo(value.error, "event.error"),
  };
}

function readError(value: Record<string, unknown>): SessionErrorEvent {
  return {
    type: SessionEventType.Error,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    step: expectNonNegativeInteger(value.step, "event.step"),
    stage: readEnum(
      value.stage,
      [
        AgentErrorStage.Configuration,
        AgentErrorStage.Context,
        AgentErrorStage.Model,
        AgentErrorStage.Response,
        AgentErrorStage.Tools,
      ],
      "event.stage",
    ),
    error: readErrorInfo(value.error, "event.error"),
  };
}

function readTurnFinished(
  value: Record<string, unknown>,
): SessionTurnFinishedEvent {
  const base = {
    type: SessionEventType.TurnFinished as const,
    turnId: asTurnId(expectNonEmptyString(value.turnId, "event.turnId")),
    output: expectString(value.output, "event.output"),
    steps: expectNonNegativeInteger(value.steps, "event.steps"),
    usage: readTokenUsage(value.usage, "event.usage"),
  };
  const status = readEnum(
    value.status,
    [AgentStatus.Completed, AgentStatus.MaxSteps, AgentStatus.Aborted],
    "event.status",
  );
  if (status === AgentStatus.Aborted) {
    // Legacy records predate partial snapshots, so an absent messages field
    // means "keep the previously committed conversation".
    const messages =
      value.messages === undefined
        ? undefined
        : readMessages(value.messages, "event.messages");
    return omitUndefined({
      ...base,
      status: AgentStatus.Aborted,
      messages,
    });
  }
  const event: SessionTurnCommittedEvent = {
    ...base,
    status,
    messages: readMessages(value.messages, "event.messages"),
  };
  return event;
}

function readCompaction(value: Record<string, unknown>): CompactionEntry {
  return {
    type: SessionEventType.Compaction,
    summary: expectString(value.summary, "event.summary"),
    cutoffSequence: expectNonNegativeInteger(
      value.cutoffSequence,
      "event.cutoffSequence",
    ),
    tokensBefore: expectNonNegativeNumber(
      value.tokensBefore,
      "event.tokensBefore",
    ),
    at: expectNonNegativeInteger(value.at, "event.at"),
  };
}

function readRetraction(
  value: Record<string, unknown>,
): SessionRetractionEvent {
  return {
    type: SessionEventType.Retraction,
    retractsSequence: expectPositiveInteger(
      value.retractsSequence,
      "event.retractsSequence",
    ),
    reason: expectString(value.reason, "event.reason"),
  };
}

function readReset(): SessionResetEvent {
  return { type: SessionEventType.Reset };
}

/**
 * Decodes the persisted session-event union. This is the JSON trust boundary:
 * every nested value (including tool-call arguments) is validated and cloned,
 * and arguments narrow to `JsonObject`.
 */
export class SessionEventCodec implements EventLogCodec<SessionEvent> {
  readonly version = 1;

  decode(value: unknown): SessionEvent {
    const record = expectRecord(value, "event");
    const type = expectNonEmptyString(record.type, "event.type");
    switch (type) {
      case SessionEventType.Header:
        return readHeader(record);
      case SessionEventType.MetadataChanged:
        return readMetadataChanged(record);
      case SessionEventType.TurnStarted:
        return readTurnStarted(record);
      case SessionEventType.StepStarted:
        return readStepStarted(record);
      case SessionEventType.ContextPrepared:
        return readContextPrepared(record);
      case SessionEventType.ModelResponded:
        return readModelResponded(record);
      case SessionEventType.ToolStarted:
        return readToolStarted(record);
      case SessionEventType.ToolCompleted:
        return readToolCompleted(record);
      case SessionEventType.Warning:
        return readWarning(record);
      case SessionEventType.Error:
        return readError(record);
      case SessionEventType.TurnFinished:
        return readTurnFinished(record);
      case SessionEventType.Compaction:
        return readCompaction(record);
      case SessionEventType.Retraction:
        return readRetraction(record);
      case SessionEventType.Reset:
        return readReset();
      default:
        return invalid("event.type", `is unknown: ${type}`);
    }
  }
}

/** Validate an in-memory event before persistence without changing its shape. */
export function assertJsonSafeSessionEvent(event: SessionEvent): void {
  readJsonValue(event, "event");
}

/**
 * Convert an agent model response to the persisted view. Throws before the
 * caller appends if any tool argument is not JSON-safe.
 */
export function persistedModelResponse(
  response: ModelResponse,
  label = "response",
): PersistedModelResponse {
  const toolCalls = response.toolCalls.map((call, index) => ({
    id: call.id,
    name: call.name,
    arguments: readJsonObject(
      call.arguments,
      `${label}.toolCalls[${index}].arguments`,
    ),
  }));
  return omitUndefined({
    text: response.text,
    toolCalls,
    usage: response.usage === undefined ? undefined : { ...response.usage },
  });
}

/** The event type lookup is exported for exhaustive codec tests. */
export type SessionEventByType<TType extends SessionEventType> =
  SessionEventMap[TType];
