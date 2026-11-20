import {
  ERROR_MESSAGES,
  ErrorCode,
  EventLogError,
  SessionLogError,
  toError,
} from "../errors";
import type {
  EventLogRecord,
} from "../types/event-log";
import { asEventLogStreamId } from "../types/ids";
import type { SessionId, TurnId } from "../types/ids";
import type { JsonObject } from "../types/json-schema";
import type { Message } from "../types/message";
import type { TokenUsage } from "../types/context";
import {
  SessionEventType,
} from "../types/session";
import type {
  SessionEvent,
  SessionEventLog,
  SessionEventLogHandle,
  SessionHeader,
  SessionHeaderEvent,
  SessionMetadata,
  SessionMetadataChangedEvent,
  SessionModelRespondedEvent,
  SessionRetractionEvent,
  SessionSnapshot,
  SessionToolCompletedEvent,
  SessionTurnFinishedEvent,
} from "../types/session";
import { omitUndefined } from "../util/omit-undefined";
import { assertJsonSafeSessionEvent, SessionEventCodec } from "./codec";

export interface SessionLogOpenOptions {
  readonly log: SessionEventLog;
  readonly sessionId: SessionId;
  readonly model: string;
  readonly instructions?: string;
  readonly cwd: string;
  readonly appConfig?: JsonObject;
  /** Header schema version. Defaults to the codec version. */
  readonly version?: number;
  /** Injectable clock for deterministic headers and tests. */
  readonly now?: () => number;
  /** Injectable codec for adapters that share a different schema version. */
  readonly codec?: SessionEventCodec;
}

function eventTurnId(event: SessionEvent): TurnId | undefined {
  switch (event.type) {
    case SessionEventType.TurnStarted:
    case SessionEventType.StepStarted:
    case SessionEventType.ContextPrepared:
    case SessionEventType.ModelResponded:
    case SessionEventType.ToolStarted:
    case SessionEventType.ToolCompleted:
    case SessionEventType.Warning:
    case SessionEventType.Error:
    case SessionEventType.TurnFinished:
      return event.turnId;
    default:
      return undefined;
  }
}

function applyMetadata(
  metadata: SessionMetadata,
  event: SessionMetadataChangedEvent,
): SessionMetadata {
  return omitUndefined({
    model: event.model ?? metadata.model,
    instructions:
      event.instructions === undefined
        ? metadata.instructions
        : event.instructions,
    cwd: event.cwd ?? metadata.cwd,
    appConfig:
      event.appConfig === undefined ? metadata.appConfig : event.appConfig,
  });
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function readTurnValues(
  events: readonly SessionEvent[],
  turnId: TurnId,
): {
  readonly output: string;
  readonly steps: number;
  readonly usage: TokenUsage;
  readonly responses: readonly SessionModelRespondedEvent[];
  readonly tools: readonly SessionToolCompletedEvent[];
} {
  const responses: SessionModelRespondedEvent[] = [];
  const tools: SessionToolCompletedEvent[] = [];
  for (const event of events) {
    if (event.type === SessionEventType.ModelResponded && event.turnId === turnId) {
      responses.push(event);
    } else if (
      event.type === SessionEventType.ToolCompleted &&
      event.turnId === turnId
    ) {
      tools.push(event);
    }
  }

  const usage = zeroUsage();
  let steps = 0;
  for (const response of responses) {
    steps = Math.max(steps, response.step);
    if (response.response.usage !== undefined) {
      usage.inputTokens += response.response.usage.inputTokens;
      usage.outputTokens += response.response.usage.outputTokens;
    }
  }

  return {
    output: responses.at(-1)?.response.text ?? "",
    steps,
    usage,
    responses,
    tools,
  };
}

function assertTurnFinishedMatches(
  finished: SessionTurnFinishedEvent,
  events: readonly SessionEvent[],
): void {
  const derived = readTurnValues(events, finished.turnId);
  const mismatch = (
    field: string,
    expected: string,
    received: string,
  ): never => {
    throw new SessionLogError(
      ERROR_MESSAGES.sessionLog.turnFinishedMismatch(
        finished.turnId,
        field,
        expected,
        received,
      ),
    );
  };

  if (finished.steps !== derived.steps) {
    mismatch("steps", String(derived.steps), String(finished.steps));
  }
  if (finished.output !== derived.output) {
    mismatch("output", JSON.stringify(derived.output), JSON.stringify(finished.output));
  }
  if (
    finished.usage.inputTokens !== derived.usage.inputTokens ||
    finished.usage.outputTokens !== derived.usage.outputTokens
  ) {
    mismatch(
      "usage",
      JSON.stringify(derived.usage),
      JSON.stringify(finished.usage),
    );
  }

  const knownCalls = new Set(
    derived.responses.flatMap((response) =>
      response.response.toolCalls.map((call) => call.id),
    ),
  );
  for (const tool of derived.tools) {
    if (!knownCalls.has(tool.result.callId)) {
      mismatch(
        "toolCompleted.callId",
        "a call recorded in ModelResponded",
        tool.result.callId,
      );
    }
  }
}

function retractedTurns(
  records: readonly EventLogRecord<SessionEvent>[],
): {
  readonly turns: ReadonlySet<TurnId>;
  readonly sequences: ReadonlySet<number>;
} {
  const bySequence = new Map<number, SessionEvent>();
  for (const record of records) bySequence.set(record.sequence, record.event);

  const turns = new Set<TurnId>();
  const sequences = new Set<number>();
  for (const record of records) {
    const event = record.event;
    if (event.type !== SessionEventType.Retraction) continue;
    const target = bySequence.get(event.retractsSequence);
    if (target === undefined) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionLog.retractionTargetMissing(
          event.retractsSequence,
        ),
      );
    }
    if (target.type === SessionEventType.Header) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionLog.retractionTargetInvalid(
          event.retractsSequence,
        ),
      );
    }
    const turnId = eventTurnId(target);
    if (turnId === undefined) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionLog.retractionTargetInvalid(
          event.retractsSequence,
        ),
      );
    }
    turns.add(turnId);
    sequences.add(event.retractsSequence);
  }
  return { turns, sequences };
}

/**
 * Rebuild the session view from durable records.
 *
 * Retractions are resolved in a first pass, so an event is excluded even when
 * its retraction was appended later. Compaction clears projection state and
 * replays only the summary plus later events; the original records remain in
 * storage.
 */
export function replaySession(
  sessionId: SessionId,
  records: readonly EventLogRecord<SessionEvent>[],
): SessionSnapshot {
  const retracted = retractedTurns(records);
  let header: SessionHeader | undefined;
  let metadata: SessionMetadata | undefined;
  let summary: string | undefined;
  let cutoffSequence: number | undefined;
  let messages: Message[] = [];
  /** Sequence of the TurnFinished that produced the current full snapshot. */
  let messagesSequence = 0;
  let activeTurnId: TurnId | undefined;
  /** Sequence of the TurnStarted that opened the active turn. */
  let activeTurnSequence: number | undefined;
  let lastSequence = 0;
  let expectedSequence = 1;

  for (const record of records) {
    if (record.sequence !== expectedSequence) {
      throw new SessionLogError(
        ERROR_MESSAGES.eventLog.invalidRecord("sequences must be contiguous"),
      );
    }
    expectedSequence += 1;
    lastSequence = record.sequence;
    const event = record.event;

    if (event.type === SessionEventType.Header) {
      if (record.sequence !== 1 || header !== undefined) {
        throw new SessionLogError(ERROR_MESSAGES.sessionLog.headerMustBeFirst);
      }
      if (event.sessionId !== sessionId) {
        throw new SessionLogError(
          ERROR_MESSAGES.eventLog.invalidRecord("session id mismatch"),
        );
      }
      header = {
        sessionId: event.sessionId,
        version: event.version,
        timestamp: event.timestamp,
        model: event.model,
        instructions: event.instructions,
        cwd: event.cwd,
        appConfig: event.appConfig,
      };
      metadata = omitUndefined({
        model: event.model,
        instructions: event.instructions,
        cwd: event.cwd,
        appConfig: event.appConfig,
      });
      continue;
    }

    if (event.type === SessionEventType.MetadataChanged) {
      if (metadata === undefined) {
        throw new SessionLogError(ERROR_MESSAGES.sessionLog.missingHeader);
      }
      metadata = applyMetadata(metadata, event);
      continue;
    }

    if (retracted.sequences.has(record.sequence)) continue;
    const turnId = eventTurnId(event);
    if (turnId !== undefined && retracted.turns.has(turnId)) continue;

    switch (event.type) {
      case SessionEventType.Reset:
        messages = [];
        messagesSequence = record.sequence;
        summary = undefined;
        cutoffSequence = undefined;
        activeTurnId = undefined;
        activeTurnSequence = undefined;
        break;

      case SessionEventType.Compaction:
        // The summary replaces projection state through cutoffSequence, but
        // events after the cutoff stay visible. A snapshot committed after the
        // cutoff therefore survives; an older one is discarded.
        summary = event.summary;
        cutoffSequence = event.cutoffSequence;
        if (messagesSequence <= event.cutoffSequence) {
          messages = [];
        }
        if (
          activeTurnSequence !== undefined &&
          activeTurnSequence <= event.cutoffSequence
        ) {
          activeTurnId = undefined;
          activeTurnSequence = undefined;
        }
        break;

      case SessionEventType.TurnStarted:
        activeTurnId = event.turnId;
        activeTurnSequence = record.sequence;
        break;

      case SessionEventType.ModelResponded:
        if (activeTurnId === event.turnId) {
          // Pending state is not committed until TurnFinished supplies the
          // authoritative full snapshot.
        }
        break;

      case SessionEventType.ToolCompleted:
        break;

      case SessionEventType.TurnFinished:
        if (event.status !== "aborted" && "messages" in event) {
          messages = [...event.messages];
          messagesSequence = record.sequence;
        }
        activeTurnId = undefined;
        activeTurnSequence = undefined;
        break;

      default:
        break;
    }
  }

  if (records.length > 0 && header === undefined) {
    throw new SessionLogError(ERROR_MESSAGES.sessionLog.missingHeader);
  }

  return omitUndefined({
    sessionId,
    header,
    metadata,
    summary,
    cutoffSequence,
    messages,
    interruptedTurnId: activeTurnId,
    lastSequence,
  });
}

/**
 * A validated, resumable session log.
 *
 * `open()` writes a header at sequence 1 and flushes it before returning.
 * TurnFinished records are checked against already-appended ModelResponded and
 * ToolCompleted events; a mismatch poisons the handle instead of leaving a
 * corrupt history that later replay would trust.
 */
export class SessionLog {
  readonly sessionId: SessionId;
  readonly #handle: SessionEventLogHandle;
  readonly #codec: SessionEventCodec;
  readonly #events: SessionEvent[] = [];
  #poisoned: Error | undefined;
  #closed = false;
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    sessionId: SessionId,
    handle: SessionEventLogHandle,
    codec: SessionEventCodec,
    events: readonly SessionEvent[],
  ) {
    this.sessionId = sessionId;
    this.#handle = handle;
    this.#codec = codec;
    events.forEach((event, index) => {
      this.#events[index] = event;
    });
  }

  static async open(options: SessionLogOpenOptions): Promise<SessionLog> {
    if (
      typeof options.model !== "string" ||
      options.model.length === 0 ||
      typeof options.cwd !== "string" ||
      options.cwd.length === 0
    ) {
      throw new SessionLogError(
        "Session model and cwd must be non-empty strings",
      );
    }
    const codec = options.codec ?? new SessionEventCodec();
    const streamId = asEventLogStreamId(options.sessionId);
    const handle = await options.log.open(streamId);

    const events: SessionEvent[] = [];
    for await (const record of handle.read()) {
      if (record.streamId !== streamId) {
        throw new SessionLogError(
          ERROR_MESSAGES.eventLog.invalidRecord("stream id mismatch"),
        );
      }
      if (record.version !== codec.version) {
        throw new SessionLogError(
          ERROR_MESSAGES.eventLog.invalidRecord(
            `unsupported version ${record.version}`,
          ),
        );
      }
      if (record.sequence !== events.length + 1) {
        throw new SessionLogError(
          ERROR_MESSAGES.eventLog.invalidRecord("sequences must be contiguous"),
        );
      }
      const event = codec.decode(record.event);
      if (event.type === SessionEventType.Header && events.length > 0) {
        throw new SessionLogError(ERROR_MESSAGES.sessionLog.headerMustBeFirst);
      }
      events.push(event);
    }

    if (events.length === 0) {
      const header: SessionHeaderEvent = omitUndefined({
        type: SessionEventType.Header,
        sessionId: options.sessionId,
        version: options.version ?? codec.version,
        timestamp: (options.now ?? Date.now)(),
        model: options.model,
        instructions: options.instructions,
        cwd: options.cwd,
        appConfig: options.appConfig,
      });
      assertJsonSafeSessionEvent(header);
      await handle.append(header);
      await handle.flush();
      return new SessionLog(options.sessionId, handle, codec, [header]);
    }

    const first = events[0];
    if (first?.type !== SessionEventType.Header) {
      throw new SessionLogError(ERROR_MESSAGES.sessionLog.missingHeader);
    }
    if (first.sessionId !== options.sessionId) {
      throw new SessionLogError(
        ERROR_MESSAGES.eventLog.invalidRecord("session id mismatch"),
      );
    }
    return new SessionLog(options.sessionId, handle, codec, events);
  }

  get nextSequence(): number {
    return this.#handle.nextSequence;
  }

  append(event: SessionEvent): Promise<EventLogRecord<SessionEvent>> {
    const operation = this.#queue.then(() => this.#append(event));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #append(
    event: SessionEvent,
  ): Promise<EventLogRecord<SessionEvent>> {
    this.#assertWritable();

    try {
      assertJsonSafeSessionEvent(event);
      this.#validate(event);

      const record = await this.#handle.append(event);
      this.#events[record.sequence - 1] = event;
      return record;
    } catch (error) {
      this.#poisoned = toError(error);
      throw error;
    }
  }

  #validate(event: SessionEvent): void {
    if (event.type === SessionEventType.Header) {
      throw new SessionLogError(ERROR_MESSAGES.sessionLog.headerImmutable);
    }

    if (event.type === SessionEventType.MetadataChanged) {
      if (
        event.model === undefined &&
        event.instructions === undefined &&
        event.cwd === undefined &&
        event.appConfig === undefined
      ) {
        throw new SessionLogError(ERROR_MESSAGES.sessionLog.metadataMustChange);
      }
      return;
    }

    if (event.type === SessionEventType.TurnFinished) {
      if (!this.#events.some((item) => eventTurnId(item) === event.turnId)) {
        throw new SessionLogError(
          ERROR_MESSAGES.eventLog.invalidRecord(
            `turn ${event.turnId} has no recorded events`,
          ),
        );
      }
      assertTurnFinishedMatches(event, this.#events);
      return;
    }

    if (event.type === SessionEventType.Compaction) {
      const sequence = this.#handle.nextSequence;
      if (
        event.cutoffSequence < 0 ||
        event.cutoffSequence >= sequence ||
        event.cutoffSequence > this.#events.length
      ) {
        throw new SessionLogError(
          ERROR_MESSAGES.sessionLog.compactionCutoffInvalid(
            event.cutoffSequence,
            sequence,
          ),
        );
      }
      return;
    }

    if (event.type === SessionEventType.Retraction) {
      this.#validateRetraction(event);
    }
  }

  #validateRetraction(event: SessionRetractionEvent): void {
    const target = this.#events[event.retractsSequence - 1];
    if (target === undefined) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionLog.retractionTargetMissing(
          event.retractsSequence,
        ),
      );
    }
    if (eventTurnId(target) === undefined) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionLog.retractionTargetInvalid(
          event.retractsSequence,
        ),
      );
    }
    for (const item of this.#events) {
      if (
        item?.type === SessionEventType.Retraction &&
        item.retractsSequence === event.retractsSequence
      ) {
        throw new SessionLogError(
          ERROR_MESSAGES.sessionLog.retractionTargetAlreadyRetracted(
            event.retractsSequence,
          ),
        );
      }
    }
  }

  async flush(): Promise<void> {
    this.#assertWritable();
    try {
      await this.#handle.flush();
    } catch (error) {
      this.#poisoned = toError(error);
      throw error;
    }
  }

  /** Bounded snapshot of durable records, matching the event-log contract. */
  read(): AsyncIterable<EventLogRecord<SessionEvent>> {
    return this.#handle.read();
  }

  /** Replay the records durable at call time. */
  async snapshot(): Promise<SessionSnapshot> {
    const records: EventLogRecord<SessionEvent>[] = [];
    for await (const record of this.read()) records.push(record);
    return replaySession(this.sessionId, records);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#handle.close();
    } catch {
      // close() is idempotent and safe after write failures.
    }
  }

  #assertWritable(): void {
    if (this.#poisoned !== undefined) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.poisoned(this.#poisoned.message),
        ErrorCode.EventLogPoisoned,
        { cause: this.#poisoned },
      );
    }
    if (this.#closed) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.invalidRecord("session log is closed"),
      );
    }
  }
}
