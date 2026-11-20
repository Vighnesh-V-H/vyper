import { ERROR_MESSAGES, ErrorCode, EventLogError } from "../errors";
import type {
  EventLog,
  EventLogHandle,
  EventLogRecord,
} from "../types/event-log";
import type { EventLogStreamId } from "../types/ids";

interface StreamState<TEvent> {
  readonly records: EventLogRecord<TEvent>[];
  nextSequence: number;
  poisoned: Error | undefined;
}

export interface MemoryEventLogOptions {
  /** Envelope version written into every record. Defaults to 1. */
  readonly version?: number;
}

/**
 * In-memory single-writer event log used by tests and applications that only
 * need process-lifetime durability. The contract is the same as a file-backed
 * adapter: append order is call order, flush is the durability barrier, and
 * read is a bounded snapshot rather than a live tail.
 */
export class MemoryEventLog<TEvent> implements EventLog<TEvent> {
  readonly #streams = new Map<EventLogStreamId, StreamState<TEvent>>();
  readonly #version: number;

  constructor(options: MemoryEventLogOptions = {}) {
    const version = options.version ?? 1;
    if (!Number.isInteger(version) || version <= 0) {
      throw new EventLogError(ERROR_MESSAGES.eventLog.invalidRecord("version must be a positive integer"));
    }
    this.#version = version;
  }

  async open(streamId: EventLogStreamId): Promise<EventLogHandle<TEvent>> {
    let state = this.#streams.get(streamId);
    if (state === undefined) {
      state = { records: [], nextSequence: 1, poisoned: undefined };
      this.#streams.set(streamId, state);
    }
    return new MemoryEventLogHandle(streamId, state, this.#version);
  }
}

class MemoryEventLogHandle<TEvent> implements EventLogHandle<TEvent> {
  readonly streamId: EventLogStreamId;
  readonly #state: StreamState<TEvent>;
  readonly #version: number;
  #closed = false;

  constructor(
    streamId: EventLogStreamId,
    state: StreamState<TEvent>,
    version: number,
  ) {
    this.streamId = streamId;
    this.#state = state;
    this.#version = version;
  }

  get nextSequence(): number {
    return this.#state.nextSequence;
  }

  async append(event: TEvent): Promise<EventLogRecord<TEvent>> {
    this.#assertWritable();
    const record: EventLogRecord<TEvent> = {
      version: this.#version,
      streamId: this.streamId,
      sequence: this.#state.nextSequence,
      timestamp: Date.now(),
      event,
    };
    this.#state.nextSequence += 1;
    this.#state.records.push(record);
    return record;
  }

  async flush(): Promise<void> {
    this.#assertWritable();
  }

  read(): AsyncIterable<EventLogRecord<TEvent>> {
    // Capture the bounded snapshot at call time, not when the iterator is
    // first advanced. Later appends are intentionally invisible.
    const snapshot = this.#state.records.slice();
    return (async function* (): AsyncGenerator<EventLogRecord<TEvent>> {
      for (const record of snapshot) yield record;
    })();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#state.poisoned !== undefined) {
      throw this.#state.poisoned;
    }
  }

  #assertWritable(): void {
    if (this.#state.poisoned !== undefined) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.poisoned(this.#state.poisoned.message),
        ErrorCode.EventLogPoisoned,
        { cause: this.#state.poisoned },
      );
    }
    if (this.#closed) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.invalidRecord("handle is closed"),
      );
    }
  }
}
