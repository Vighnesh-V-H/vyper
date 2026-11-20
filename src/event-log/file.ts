import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
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

/** A lock file older than this without a live owner is treated as abandoned. */
const STALE_LOCK_MS = 60_000;

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly createdAt: number;
}

interface LockSnapshot {
  readonly exists: boolean;
  readonly owner?: LockOwner;
  readonly mtimeMs?: number;
}

interface ParsedRecords<TEvent> {
  readonly records: EventLogRecord<TEvent>[];
  /** Byte length of the valid prefix that may be retained on disk. */
  readonly validBytes: number;
  /** True when a valid final record was accepted without its newline. */
  readonly needsNewline: boolean;
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

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled; only ESRCH
    // proves that the owner is gone.
    return !isMissingProcess(error);
  }
}

function parseLockOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined;
  const pid = value.pid;
  const host = value.host;
  const token = value.token;
  const createdAt = value.createdAt;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    host.length === 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt)
  ) {
    return undefined;
  }
  return { pid, host, token, createdAt };
}

async function readLockSnapshot(path: string): Promise<LockSnapshot> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { exists: false };
    throw error;
  }

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    if (isMissingFile(error)) return { exists: false };
    throw error;
  }

  let owner: LockOwner | undefined;
  try {
    owner = parseLockOwner(JSON.parse(text));
  } catch {
    owner = undefined;
  }
  return { exists: true, owner, mtimeMs };
}

async function lockIsStale(path: string): Promise<boolean> {
  const snapshot = await readLockSnapshot(path);
  if (!snapshot.exists) return true;
  if (snapshot.owner !== undefined) {
    // A process on another host cannot be checked safely, so treat it as live.
    if (snapshot.owner.host !== hostname()) return false;
    return !isProcessAlive(snapshot.owner.pid);
  }
  // An empty or malformed lock is only abandoned once it has aged out. This
  // covers a crash between creating the lock and writing its owner metadata.
  return (
    snapshot.mtimeMs !== undefined &&
    Date.now() - snapshot.mtimeMs > STALE_LOCK_MS
  );
}

async function acquireBreakLock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      return true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (attempt === 0 && (await lockIsStale(path))) {
        try {
          await unlink(path);
        } catch (unlinkError) {
          if (!isMissingFile(unlinkError)) throw unlinkError;
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

/**
 * Remove an abandoned lock. A short-lived break lock serializes removal so two
 * processes cannot both delete a lock that was just recreated by the winner.
 */
async function removeStaleLock(path: string): Promise<boolean> {
  if (!(await lockIsStale(path))) return false;

  const breakPath = `${path}.break`;
  if (!(await acquireBreakLock(breakPath))) return false;
  try {
    // Re-check after taking the break lock; another process may have already
    // replaced the abandoned lock with a live one.
    if (!(await lockIsStale(path))) return false;
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return true;
  } finally {
    try {
      await unlink(breakPath);
    } catch {
      // A missing break file means another process already cleaned it up.
    }
  }
}

async function releaseLock(path: string, token: string): Promise<void> {
  const snapshot = await readLockSnapshot(path);
  // Only remove the lock when it is still the one this handle created.
  if (!snapshot.exists || snapshot.owner?.token !== token) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/**
 * Take exclusive ownership of a stream before reading it. The lock is a sibling
 * file created with O_EXCL, so a second writer cannot assign sequence numbers
 * from the same snapshot.
 */
async function acquireLock(
  path: string,
  streamId: EventLogStreamId,
): Promise<() => Promise<void>> {
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: crypto.randomUUID(),
    createdAt: Date.now(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(path, "wx");
      created = true;
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
      await handle.close();
      handle = undefined;
      return async () => releaseLock(path, owner.token);
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The original failure is the useful one.
        }
      }
      if (created) {
        try {
          await unlink(path);
        } catch {
          // The lock may already have been removed by a stale-lock recovery.
        }
      }
      if (!isAlreadyExists(error)) throw error;
      if (attempt < 2 && (await removeStaleLock(path))) continue;
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.streamLocked(String(streamId)),
      );
    }
  }

  throw new EventLogError(
    ERROR_MESSAGES.eventLog.streamLocked(String(streamId)),
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

function parseCompleteRecords<TEvent>(
  text: string,
  streamId: EventLogStreamId,
  version: number,
  codec: EventLogCodec<TEvent>,
  firstSequence: number,
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
    const expected = firstSequence + records.length;
    if (record.sequence !== expected) {
      invalid(
        `line ${lineNumber} has sequence ${record.sequence}; expected ${expected}`,
      );
    }
    records.push(record);
  }
  return records;
}

function parseRecords<TEvent>(
  data: Buffer,
  streamId: EventLogStreamId,
  version: number,
  codec: EventLogCodec<TEvent>,
): ParsedRecords<TEvent> {
  if (data.length === 0) {
    return { records: [], validBytes: 0, needsNewline: false };
  }

  // A complete record is newline-terminated. Anything after the final newline
  // is an interrupted append and must not be treated as committed history.
  if (data[data.length - 1] === 0x0a) {
    const records = parseCompleteRecords(
      data.toString("utf8"),
      streamId,
      version,
      codec,
      1,
    );
    return { records, validBytes: data.length, needsNewline: false };
  }

  const lastNewline = data.lastIndexOf(0x0a);
  const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const records = parseCompleteRecords(
    data.subarray(0, completeBytes).toString("utf8"),
    streamId,
    version,
    codec,
    1,
  );

  const tail = data.subarray(completeBytes).toString("utf8");
  const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
  if (line.trim().length === 0) {
    return { records, validBytes: completeBytes, needsNewline: false };
  }

  // A fully written record can lose only its trailing newline. Keep it when it
  // validates; otherwise discard the unterminated tail as an interrupted write.
  try {
    const parsed: unknown = JSON.parse(line);
    const record = readEnvelope(
      parsed,
      streamId,
      version,
      codec,
      records.length + 1,
    );
    if (record.sequence !== records.length + 1) {
      return { records, validBytes: completeBytes, needsNewline: false };
    }
    records.push(record);
    return { records, validBytes: data.length, needsNewline: true };
  } catch {
    return { records, validBytes: completeBytes, needsNewline: false };
  }
}

async function writeAll(file: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
    );
    if (bytesWritten <= 0) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.invalidRecord("write made no progress"),
      );
    }
    offset += bytesWritten;
  }
}

/**
 * Append-only JSONL event log with one file per stream.
 *
 * `open()` takes exclusive ownership of the stream's lock file before reading,
 * so two writers cannot derive conflicting sequence numbers from the same
 * snapshot. A second open rejects until the owning handle closes.
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
    const releaseLock = await acquireLock(`${path}.lock`, streamId);

    let file: FileHandle | undefined;
    try {
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        data = Buffer.alloc(0);
      }

      const parsed = parseRecords(data, streamId, this.#version, this.#codec);
      // Drop an interrupted tail before appending, otherwise the next record
      // would be concatenated onto the partial line. Windows rejects truncate
      // on an append-mode handle, so do it through a separate read/write handle.
      if (parsed.validBytes < data.length) {
        const truncating = await open(path, "r+");
        try {
          await truncating.truncate(parsed.validBytes);
        } finally {
          await truncating.close();
        }
      }
      const opened = await open(path, "a");
      file = opened;
      if (parsed.needsNewline) {
        await writeAll(opened, Buffer.from("\n"));
      }
      return new FileEventLogHandle(
        streamId,
        opened,
        parsed.records,
        this.#version,
        this.#codec,
        releaseLock,
      );
    } catch (error) {
      if (file !== undefined) {
        try {
          await file.close();
        } catch {
          // The original failure is the useful one.
        }
      }
      try {
        await releaseLock();
      } catch {
        // Releasing a lock must not mask the open failure.
      }
      throw error;
    }
  }
}

class FileEventLogHandle<TEvent> implements EventLogHandle<TEvent> {
  readonly streamId: EventLogStreamId;
  readonly #file: FileHandle;
  readonly #records: EventLogRecord<TEvent>[];
  readonly #version: number;
  readonly #codec: EventLogCodec<TEvent>;
  readonly #releaseLock: () => Promise<void>;
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
    codec: EventLogCodec<TEvent>,
    releaseLock: () => Promise<void>,
  ) {
    this.streamId = streamId;
    this.#file = file;
    this.#records = records;
    this.#version = version;
    this.#codec = codec;
    this.#releaseLock = releaseLock;
    this.#nextSequence = records.length + 1;
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  async append(event: TEvent): Promise<EventLogRecord<TEvent>> {
    this.#assertAccepting();
    // Validate before assigning a sequence so a rejected event cannot leave a
    // gap in the stream. The codec also returns the persisted, JSON-safe view.
    const validated = this.#codec.decode(event);
    const record: EventLogRecord<TEvent> = {
      version: this.#version,
      streamId: this.streamId,
      sequence: this.#nextSequence,
      timestamp: Date.now(),
      event: validated,
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
    try {
      await this.#releaseLock();
    } catch {
      // A failed unlock leaves a stale lock that the next open can recover.
    }
  }

  async #write(record: EventLogRecord<TEvent>): Promise<void> {
    this.#assertOpen();
    try {
      // The codec already validated and cloned the event. Write the complete
      // line, looping on short writes so framing is never silently truncated.
      await writeAll(
        this.#file,
        Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
      );
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
