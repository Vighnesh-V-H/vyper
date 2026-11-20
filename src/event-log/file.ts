import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
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

interface GuardSlot {
  readonly path: string;
  readonly token: string;
}

/** Guard slots owned by this process, so concurrent opens see them as live. */
const activeGuardTokens = new Set<string>();

function guardPathFor(lockPath: string, slot: number): string {
  return `${lockPath}.guard.${slot}`;
}

async function guardSlotIsLive(path: string): Promise<boolean> {
  const snapshot = await readLockSnapshot(path);
  if (!snapshot.exists) return false;
  if (snapshot.owner !== undefined) {
    if (snapshot.owner.host !== hostname()) return true;
    if (snapshot.owner.pid === process.pid) {
      return activeGuardTokens.has(snapshot.owner.token);
    }
    return isProcessAlive(snapshot.owner.pid);
  }
  // An empty or malformed slot is live until it has had time to be written.
  return (
    snapshot.mtimeMs === undefined ||
    Date.now() - snapshot.mtimeMs <= STALE_LOCK_MS
  );
}

async function nextGuardSlot(lockPath: string): Promise<number> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.guard.`;
  const entries = await readdir(directory);
  let max = -1;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(suffix)) continue;
    const slot = Number(suffix);
    if (Number.isSafeInteger(slot) && slot > max) max = slot;
  }
  return max + 1;
}

async function releaseGuard(guard: GuardSlot): Promise<void> {
  activeGuardTokens.delete(guard.token);
  try {
    await unlink(guard.path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/**
 * Take the recovery guard. Guard slots are immutable files allocated above
 * every existing slot, and no process ever removes another process's slot. A
 * later contender therefore cannot replace or delete an earlier guard, and the
 * lowest live slot is the only winner.
 */
async function acquireGuard(
  lockPath: string,
  owner: LockOwner,
): Promise<GuardSlot | undefined> {
  const guardOwner: LockOwner = { ...owner, token: crypto.randomUUID() };
  let slot = -1;
  let guardPath: string | undefined;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    slot = await nextGuardSlot(lockPath);
    const candidate = guardPathFor(lockPath, slot);
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(candidate, "wx");
      created = true;
      // Publish ownership before the slot becomes visible to same-process
      // contenders; a partial write is still treated as live until it ages out.
      activeGuardTokens.add(guardOwner.token);
      await handle.writeFile(JSON.stringify(guardOwner));
      await handle.sync();
      await handle.close();
      handle = undefined;
      guardPath = candidate;
      break;
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The original failure is the useful one.
        }
      }
      if (created) {
        activeGuardTokens.delete(guardOwner.token);
        try {
          await unlink(candidate);
        } catch {
          // An unreadable slot is skipped once its owner is gone.
        }
      }
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }

  if (guardPath === undefined) return undefined;
  const guard: GuardSlot = { path: guardPath, token: guardOwner.token };

  try {
    // Slots are allocated above every existing slot, so only lower slots can
    // preempt this guard. Later contenders are guaranteed to be above us.
    for (let lower = 0; lower < slot; lower += 1) {
      if (await guardSlotIsLive(guardPathFor(lockPath, lower))) {
        try {
          await releaseGuard(guard);
        } catch {
          // The slot expires with this process; losing the election is enough.
        }
        return undefined;
      }
    }
    return guard;
  } catch (error) {
    try {
      await releaseGuard(guard);
    } catch {
      // Preserve the original election failure.
    }
    throw error;
  }
}

/**
 * Remove an abandoned lock. The caller must hold the recovery guard. Creation
 * and removal share that guard, so a process can never delete a lock another
 * process created after the stale check.
 */
async function removeStaleLock(path: string): Promise<boolean> {
  if (!(await lockIsStale(path))) return false;
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return true;
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

async function createLock(
  path: string,
  owner: LockOwner,
): Promise<(() => Promise<void>) | undefined> {
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
    if (isAlreadyExists(error)) return undefined;
    throw error;
  }
}

/**
 * Take exclusive ownership of a stream before reading it. The lock is a sibling
 * file created with O_EXCL, so a second writer cannot assign sequence numbers
 * from the same snapshot.
 *
 * Creation is attempted directly. Stale recovery takes a recovery guard that
 * serializes all recoverers. The guard uses immutable slots: each contender
 * allocates a new slot and the lowest live slot wins, so recovering a guard
 * never deletes a guard another process just created.
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
  const locked = (): EventLogError =>
    new EventLogError(ERROR_MESSAGES.eventLog.streamLocked(String(streamId)));

  const created = await createLock(path, owner);
  if (created !== undefined) return created;
  if (!(await lockIsStale(path))) throw locked();

  const guard = await acquireGuard(path, owner);
  if (guard === undefined) throw locked();
  try {
    // Re-check after winning the guard. Another process may have recovered the
    // lock between the initial check and guard acquisition.
    if (!(await removeStaleLock(path))) throw locked();

    // If a direct creator wins the race after the stale lock is removed, its
    // live lock must be left alone. Do not retry removal here.
    const recovered = await createLock(path, owner);
    if (recovered === undefined) throw locked();
    return recovered;
  } finally {
    try {
      await releaseGuard(guard);
    } catch {
      // A leftover slot is skipped after this process exits. Never mask a
      // successful acquisition or leak the main lock because cleanup failed.
    }
  }
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
  // validates. A JSON syntax error means the tail is an interrupted write and
  // may be discarded, but a complete JSON value that fails envelope or payload
  // validation is incompatible history and must be reported, not truncated.
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { records, validBytes: completeBytes, needsNewline: false };
  }
  const lineNumber = records.length + 1;
  const record = readEnvelope(parsed, streamId, version, codec, lineNumber);
  if (record.sequence !== lineNumber) {
    invalid(
      `line ${lineNumber} has sequence ${record.sequence}; expected ${lineNumber}`,
    );
  }
  records.push(record);
  return { records, validBytes: data.length, needsNewline: true };
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
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #fileClosed = false;
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
    if (this.#closePromise !== undefined) return this.#closePromise;
    const operation = this.#close();
    this.#closePromise = operation;
    try {
      await operation;
    } finally {
      this.#closePromise = undefined;
    }
  }

  async #close(): Promise<void> {
    this.#closing = true;
    try {
      await this.#queue;
    } catch {
      // Writes already report and poison the handle; close still releases it.
    }
    if (!this.#fileClosed) {
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
      this.#fileClosed = true;
    }
    // Surface unlock failures and leave #closed unset so a later close() can
    // retry. Otherwise the lock would stay live for as long as this process.
    await this.#releaseLock();
    this.#closed = true;
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
