/**
 * Provider-neutral append-only event log.
 *
 * The port is intentionally small: a factory opens a named stream, and the
 * returned handle is the only way to append, read, or force durability. The
 * agent loop never sees this contract; applications and sessions depend on it.
 */

import type { EventLogStreamId } from "./ids";

export type { EventLogStreamId } from "./ids";

/**
 * One persisted event, tagged with the information needed to detect gaps,
 * duplicated streams, and incompatible formats during replay.
 */
export interface EventLogRecord<TEvent> {
  /** Envelope schema version. Must match the codec used by the adapter. */
  readonly version: number;
  readonly streamId: EventLogStreamId;
  /** 1-based, contiguous position within the stream. */
  readonly sequence: number;
  /** Unix epoch milliseconds assigned when the event was accepted. */
  readonly timestamp: number;
  readonly event: TEvent;
}

/**
 * Validates and decodes an event payload at the persistence trust boundary.
 *
 * Adapters own envelope framing. Codecs own the event union, so an adapter can
 * stay generic while every store still returns fully typed domain events.
 *
 * `decode` must reject malformed, non-JSON values and return the persisted
 * view. Domain types may use richer in-memory values; the persisted view is
 * where those values narrow to JSON-safe shapes (for example tool arguments
 * become `JsonObject`).
 */
export interface EventLogCodec<TEvent> {
  /** Envelope version written by this adapter/codec pair. */
  readonly version: number;
  /** Throw when `value` is not a valid, JSON-safe event. */
  decode(value: unknown): TEvent;
}

/**
 * A single-writer view of one stream.
 *
 * Contract:
 * - `append()` assigns monotonically increasing sequence numbers in call
 *   order, even when calls are issued concurrently. It resolves once the event
 *   is accepted for writing, not necessarily once it is durable.
 * - `flush()` is a durability barrier: every append issued before the call is
 *   durable when it resolves. It is the only way callers can know a crash will
 *   not lose accepted records.
 * - `read()` is a bounded snapshot, not a live tail. It yields exactly the
 *   records that were durable when `read()` was called, in ascending sequence
 *   order, and then completes. It never waits for future appends. A live tail
 *   is intentionally reserved for a future `tail()` method rather than
 *   overloading `read()`.
 * - After an append or flush failure the handle is poisoned. Further appends
 *   and flushes reject instead of silently writing an incomplete history.
 * - `close()` flushes and is idempotent. It is safe to call after failures.
 */
export interface EventLogHandle<TEvent> {
  readonly streamId: EventLogStreamId;
  /** Sequence number that will be assigned to the next accepted append. */
  readonly nextSequence: number;

  append(event: TEvent): Promise<EventLogRecord<TEvent>>;

  /** Barrier that resolves only when prior appends are durable. */
  flush(): Promise<void>;

  /**
   * Iterate the records durable at call time, in ascending sequence order.
   * The returned iterable is a snapshot and completes after the last record.
   */
  read(): AsyncIterable<EventLogRecord<TEvent>>;

  close(): Promise<void>;
}

/** Opens (creating when necessary) named append-only streams. */
export interface EventLog<TEvent> {
  open(streamId: EventLogStreamId): Promise<EventLogHandle<TEvent>>;
}
