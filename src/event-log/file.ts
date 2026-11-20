import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  ERROR_MESSAGES,
  ErrorCode,
  EventLogError,
  errorMessage,
  toError,
} from "../errors";
import type {
  EventLog,
  EventLogCodec,
  EventLogHandle,
  EventLogRecord,
} from "../types/event-log";
import type { EventLogStreamId } from "../types/ids";

export interface FileEventLogOptions<TEvent> {
  /** Directory holding one JSONL file per stream. Created when missing. */
  readonly directory: string;
  /** Decodes untrusted event payloads when a stream is opened. */
  readonly codec: EventLogCodec<TEvent>;
  /** Envelope version written and accepted. Defaults to the codec version. */
  readonly version?: number;
}

function invalid(detail: string): never {
  throw new EventLogError(ERROR_MESSAGES.eventLog.invalidRecord(detail));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * A stream id must never escape the configured directory. Encoding keeps the
 * file name readable for normal ids while turning separators into `%2F`/`%5C`.
 */
function fileNameFor(streamId: EventLogStreamId): string {
  return `${encodeURIComponent(streamId)}.jsonl`;
}

function readEnvelope<TEvent>(
  value: unknown,
  streamId: EventLogStreamId,
  version: number,
  codec: EventLogCodec<TEvent>,
  line: number,
): EventLogRecord<TEvent> {
  if (!isRecord(value)) invalid(`line ${line} must be an object`);
  if (typeof value.version !== "number" || value.version !== version) {
    invalid(`line ${line} has unsupported version ${String(value.version)}`);
  }
  if (value.streamId !== streamId) {
    invalid(`line ${line} belongs to another stream`);
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence <= 0
  ) {
    invalid(`line ${line} has an invalid sequence`);
  }
  if (
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    invalid(`line ${line} has an invalid timestamp`);
  }
  if (!("event" in value)) invalid(`line ${line} is missing an event`);
  return {
    version,
    streamId,
    sequence: value.sequence,
    timestamp: value.timestamp,
    event: codec.decode(value.event),
  };
}

function parseRecords<TEvent>(
  text: string,
  streamId: EventLogStreamId,
  version: number,
  codec: EventLogCodec<TEvent>,
): EventLogRecord<TEvent>[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline terminates the last record; it is not an empty record.
  if (lines.at(-1) === "") lines.pop();

  const records: EventLogRecord<TEvent>[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      invalid(`line ${lineNumber} is empty`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      invalid(`line ${lineNumber} is not valid JSON: ${errorMessage(error)}`);
    }
    const record = readEnvelope(parsed, streamId, version, codec, lineNumber);
    if (record.sequence !== records.length + 1) {
      invalid(
        `line ${lineNumber} has sequence ${record.sequence}; expected ${records.length + 1}`,
      );
    }
    records.push(record);
  }
  return records;
}

/**
 * Append-only JSONL event log with one file per stream.
 *
 * Every append is serialized through a queue so sequence order and file order
 * agree. `flush()` is the durability barrier: it waits for queued writes and
 * syncs the file. `read()` returns an in-memory snapshot of accepted records,
 * matching the bounded-read contract of `EventLogHandle`.
 */
export class FileEventLog<TEvent> implements EventLog<TEvent> {
  readonly #directory: string;
  readonly #codec: EventLogCodec<TEvent>;
  readonly #version: number;

  constructor(options: FileEventLogOptions<TEvent>) {
    if (
      typeof options.directory !== "string" ||
      options.directory.length === 0
    ) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.invalidRecord(
          "directory must be a non-empty string",
        ),
      );
    }
    const version = options.version ?? options.codec.version;
    if (!Number.isInteger(version) || version <= 0) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.invalidRecord(
          "version must be a positive integer",
        ),
      );
    }
    this.#directory = options.directory;
    this.#codec = options.codec;
    this.#version = version;
  }

  async open(streamId: EventLogStreamId): Promise<EventLogHandle<TEvent>> {
    if (streamId.length === 0) {
      invalid("stream id must be non-empty");
    }
    await mkdir(this.#directory, { recursive: true });
    const path = join(this.#directory, fileNameFor(streamId));

    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const records = parseRecords(text, streamId, this.#version, this.#codec);
    const file = await open(path, "a");
    return new FileEventLogHandle(streamId, file, records, this.#version);
  }
}

class FileEventLogHandle<TEvent> implements EventLogHandle<TEvent> {
  readonly streamId: EventLogStreamId;
  readonly #file: FileHandle;
  readonly #records: EventLogRecord<TEvent>[];
  readonly #version: number;
  #nextSequence: number;
  #queue: Promise<void> = Promise.resolve();
  #poisoned: Error | undefined;
  #closing = false;
  #closed = false;

  constructor(
    streamId: EventLogStreamId,
    file: FileHandle,
    records: EventLogRecord<TEvent>[],
    version: number,
  ) {
    this.streamId = streamId;
    this.#file = file;
    this.#records = records;
    this.#version = version;
    this.#nextSequence = records.length + 1;
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  async append(event: TEvent): Promise<EventLogRecord<TEvent>> {
    this.#assertAccepting();
    const record: EventLogRecord<TEvent> = {
      version: this.#version,
      streamId: this.streamId,
      sequence: this.#nextSequence,
      timestamp: Date.now(),
      event,
    };
    this.#nextSequence += 1;

    const operation = this.#queue.then(() => this.#write(record));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return record;
  }

  async flush(): Promise<void> {
    this.#assertAccepting();
    await this.#queue;
    this.#assertAccepting();
    try {
      await this.#file.sync();
    } catch (error) {
      this.#poison(toError(error));
      throw error;
    }
  }

  read(): AsyncIterable<EventLogRecord<TEvent>> {
    // Capture the snapshot at call time; later appends stay invisible.
    const snapshot = this.#records.slice();
    return (async function* (): AsyncGenerator<EventLogRecord<TEvent>> {
      for (const record of snapshot) yield record;
    })();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      await this.#queue;
    } catch {
      // Writes already report and poison the handle; close still releases it.
    }
    this.#closed = true;
    try {
      if (this.#poisoned === undefined) await this.#file.sync();
    } catch {
      // Closing must remain safe after write or sync failures.
    }
    try {
      await this.#file.close();
    } catch {
      // Already closed or otherwise unusable; nothing else to release.
    }
  }

  async #write(record: EventLogRecord<TEvent>): Promise<void> {
    this.#assertOpen();
    try {
      // The codec owns event validation; stringify also rejects cycles and
      // non-JSON values so a bad event cannot produce a partial line.
      const line = `${JSON.stringify(record)}\n`;
      await this.#file.write(line);
      this.#records.push(record);
    } catch (error) {
      this.#poison(toError(error));
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#poisoned !== undefined) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.poisoned(this.#poisoned.message),
        ErrorCode.EventLogPoisoned,
        { cause: this.#poisoned },
      );
    }
    if (this.#closed) {
      invalid("handle is closed");
    }
  }

  #assertAccepting(): void {
    this.#assertOpen();
    if (this.#closing) {
      invalid("handle is closing");
    }
  }

  #poison(error: Error): void {
    if (this.#poisoned === undefined) this.#poisoned = error;
  }
}
