import {
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  /**
   * Age in ms after which a lock or guard with no checkable owner (malformed,
   * or owned by another host) is treated as abandoned. Defaults to 60s.
   */
  readonly staleLockMs?: number;
}

/**
 * Default age after which a lock or guard whose owner cannot be checked is
 * abandoned. Override per instance with `staleLockMs`; raise it on NFS/FUSE,
 * where mtimes lag and clocks differ between hosts.
 */
const DEFAULT_STALE_LOCK_MS = 60_000;

/** How many times an opener retries after losing the guard election. */
const GUARD_ATTEMPTS = 40;

/** Owner-only permissions: event payloads may be sensitive. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Randomized, capped exponential backoff so losing contenders desynchronize. */
function backoffMs(attempt: number): number {
  return 1 + Math.random() * Math.min(50, 2 ** attempt);
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

/**
 * fsync a directory so created or removed entries survive a crash. File
 * fsync alone does not make the directory entry durable. Platforms that cannot
 * open or sync directories (Windows) report these codes; anything else, such
 * as EIO, is a real failure and propagates.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, ["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EACCES"])) {
      throw error;
    }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Nothing useful to do if a read-only handle fails to close.
      }
    }
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

/**
 * Read content and mtime through one file handle so both describe the same
 * inode even if the path is unlinked and recreated while we look at it.
 */
async function readLockSnapshot(path: string): Promise<LockSnapshot> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissingFile(error)) return { exists: false };
    throw error;
  }

  try {
    const text = await handle.readFile({ encoding: "utf8" });
    const mtimeMs = (await handle.stat()).mtimeMs;
    let owner: LockOwner | undefined;
    try {
      owner = parseLockOwner(JSON.parse(text));
    } catch {
      owner = undefined;
    }
    return { exists: true, owner, mtimeMs };
  } finally {
    try {
      await handle.close();
    } catch {
      // Nothing useful to do if a read-only handle fails to close.
    }
  }
}

async function lockIsStale(path: string, staleMs: number): Promise<boolean> {
  const snapshot = await readLockSnapshot(path);
  if (!snapshot.exists) return true;
  if (snapshot.owner !== undefined) {
    // A process on another host cannot be checked safely, so treat it as live.
    if (snapshot.owner.host !== hostname()) return false;
    // Known limitation: a reused PID makes a crashed owner's lock look live
    // until that PID exits, and the age fallback below is not consulted for
    // locks with readable metadata. Closing this needs a heartbeat or lease.
    return !isProcessAlive(snapshot.owner.pid);
  }
  // An empty or malformed lock is only abandoned once it has aged out. This
  // covers a crash between creating the lock and writing its owner metadata.
  return (
    snapshot.mtimeMs !== undefined &&
    Date.now() - snapshot.mtimeMs > staleMs
  );
}

interface GuardSlot {
  readonly path: string;
  readonly token: string;
}

/** Guard files owned by this process, so concurrent opens see them as live. */
const activeGuardTokens = new Set<string>();

function guardPrefixFor(lockPath: string): string {
  return `${basename(lockPath)}.guard.`;
}

/**
 * A guard is live while its owner can still be running. Guards are held only
 * for the duration of one acquire attempt, so a guard from another host that
 * has not been touched for `staleMs` is abandoned too.
 */
async function guardIsLive(path: string, staleMs: number): Promise<boolean> {
  const snapshot = await readLockSnapshot(path);
  if (!snapshot.exists) return false;
  const recent =
    snapshot.mtimeMs === undefined ||
    Date.now() - snapshot.mtimeMs <= staleMs;
  if (snapshot.owner !== undefined) {
    if (snapshot.owner.host !== hostname()) return recent;
    if (snapshot.owner.pid === process.pid) {
      return activeGuardTokens.has(snapshot.owner.token);
    }
    return isProcessAlive(snapshot.owner.pid);
  }
  // An empty or malformed guard is live until it has had time to be written.
  return recent;
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
 * Take the mutual-exclusion guard that serializes every lock creation and
 * every stale-lock removal for one stream.
 *
 * Each contender creates a uniquely named guard file, publishes it, and only
 * then lists the other guard files. It wins only if no other live guard exists.
 * Because every contender creates before it checks, two contenders can never
 * both see "alone": whichever checks second sees the other's file. If both see
 * each other, both back off and retry with jitter, which costs time but never
 * safety. Names are unique and never reused, so removing a dead owner's file
 * cannot delete a guard that another process created later.
 *
 * Invariants a refactor must preserve:
 *  - Create and publish your own guard file BEFORE listing the others. Listing
 *    first reintroduces a window where two contenders both see "alone".
 *  - A loser deletes its own guard file before backing off, so it cannot block
 *    the next round.
 *  - The caller keeps the guard until its create/stale-check/remove sequence
 *    has finished. Releasing early lets another opener interleave with it.
 *  - Never recompute "lowest wins" or reuse guard names; uniqueness is what
 *    makes removing dead guards safe.
 */
async function acquireGuard(
  lockPath: string,
  owner: LockOwner,
  staleMs: number,
): Promise<GuardSlot | undefined> {
  const token = randomUUID();
  const guardOwner: LockOwner = { ...owner, token, createdAt: Date.now() };
  const guard: GuardSlot = { path: `${lockPath}.guard.${token}`, token };
  const ownName = basename(guard.path);
  const prefix = guardPrefixFor(lockPath);
  const directory = dirname(lockPath);

  // Registered before the file exists so a same-process contender that sees
  // the file mid-write never mistakes it for an abandoned guard.
  activeGuardTokens.add(token);
  let handle: FileHandle | undefined;
  try {
    handle = await open(guard.path, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(JSON.stringify(guardOwner));
    await handle.sync();
    await handle.close();
    handle = undefined;

    for (const name of await readdir(directory)) {
      if (name === ownName || !name.startsWith(prefix)) continue;
      const other = join(directory, name);
      if (await guardIsLive(other, staleMs)) {
        await releaseGuard(guard);
        return undefined;
      }
      // The owner is gone and the name can never be reused, so removing it is
      // safe. Cleanup is best effort.
      try {
        await unlink(other);
      } catch {
        // Another contender may have cleaned it up first.
      }
    }
    return guard;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The original failure is the useful one.
      }
    }
    try {
      await releaseGuard(guard);
    } catch {
      // Preserve the original election failure.
    }
    throw error;
  }
}

/**
 * Remove an abandoned lock. The caller must hold the guard. Creation and
 * removal share that guard, so a process can never delete a lock another
 * process created after the stale check.
 */
async function removeStaleLock(
  path: string,
  staleMs: number,
): Promise<boolean> {
  if (!(await lockIsStale(path, staleMs))) return false;
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return true;
}

async function releaseLock(path: string, token: string): Promise<void> {
  const snapshot = await readLockSnapshot(path);
  // Only remove the lock when it is still the one this handle created. A live
  // lock is never removed by recovery, so nothing can replace it between this
  // check and the unlink.
  if (!snapshot.exists || snapshot.owner?.token !== token) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/** Create the lock file. The caller must hold the guard. */
async function createLock(
  path: string,
  owner: LockOwner,
): Promise<(() => Promise<void>) | undefined> {
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
    created = true;
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Make the directory entry durable too; otherwise a crash can leave the
    // lock missing or zero-length after reboot.
    await syncDirectory(dirname(path));
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
        // The lock may already have been removed.
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
 * Every creation attempt, stale check and stale removal runs under the guard
 * (see acquireGuard). Nothing creates the main lock outside the guard, so a
 * recoverer that observes "missing" or "stale" cannot have that observation
 * invalidated by a concurrent creator before it acts on it.
 */
async function acquireLock(
  path: string,
  streamId: EventLogStreamId,
  staleMs: number,
): Promise<() => Promise<void>> {
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    createdAt: Date.now(),
  };
  const locked = (): EventLogError =>
    new EventLogError(ERROR_MESSAGES.eventLog.streamLocked(String(streamId)));

  for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt += 1) {
    const guard = await acquireGuard(path, owner, staleMs);
    if (guard === undefined) {
      // Another opener is inside the critical section or electing at the same
      // time. Back off; the lock state may change before the next attempt.
      await sleep(backoffMs(attempt));
      continue;
    }
    try {
      const created = await createLock(path, owner);
      if (created !== undefined) return created;

      // The lock exists. Remove it only if its owner is gone; a live lock is
      // a genuine "stream is open elsewhere" rejection.
      if (!(await removeStaleLock(path, staleMs))) throw locked();

      // Still under the guard, so no other opener can have created the lock
      // since the removal above.
      const recovered = await createLock(path, owner);
      if (recovered === undefined) throw locked();
      return recovered;
    } finally {
      try {
        await releaseGuard(guard);
      } catch {
        // A leftover guard file is skipped once this process exits. Never mask
        // a successful acquisition or leak the main lock because cleanup
        // failed.
      }
    }
  }
  throw locked();
}

/**
 * A stream id must never escape the configured directory. Encoding keeps the
 * file name readable for normal ids while turning separators into `%2F`/`%5C`.
 * The encoded name can never contain a path separator, so containment holds by
 * construction. It does not defend against a symlink planted inside the log
 * directory; that needs filesystem permissions, not name handling.
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

/**
 * Write the whole buffer, looping on short writes. The handle is opened in
 * append mode and no `position` is passed, so the kernel places every write at
 * the end of the file. `offset` here is an offset INTO THE BUFFER, not the
 * file. Do not pass a file position: it would be ignored or break framing.
 */
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
 * syncs the file. `read()` returns an in-memory snapshot of the durable prefix:
 * records covered by a successful `flush()` (or loaded from disk at open).
 * Appended records become readable after the next `flush()`.
 */
export class FileEventLog<TEvent> implements EventLog<TEvent> {
  readonly #directory: string;
  readonly #codec: EventLogCodec<TEvent>;
  readonly #version: number;
  readonly #staleLockMs: number;

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
    const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    if (!Number.isFinite(staleLockMs) || staleLockMs <= 0) {
      throw new EventLogError(
        ERROR_MESSAGES.eventLog.invalidRecord(
          "staleLockMs must be a positive number",
        ),
      );
    }
    this.#directory = options.directory;
    this.#codec = options.codec;
    this.#version = version;
    this.#staleLockMs = staleLockMs;
  }

  async open(streamId: EventLogStreamId): Promise<EventLogHandle<TEvent>> {
    if (streamId.length === 0) {
      invalid("stream id must be non-empty");
    }
    const madeDirectory = await mkdir(this.#directory, {
      recursive: true,
      mode: PRIVATE_DIR_MODE,
    });
    if (madeDirectory !== undefined) {
      // recursive mkdir returns the FIRST directory it created. Every directory
      // from there down to the log directory is new, and each one's entry lives
      // in its parent, so sync the whole chain plus the first one's parent.
      // Syncing only the endpoints would leave intermediate entries (for
      // example `.vyper` inside the repo, or `sessions` inside `.vyper`)
      // volatile.
      const first = resolve(madeDirectory);
      let current = resolve(this.#directory);
      const chain: string[] = [];
      for (;;) {
        chain.push(current);
        if (current === first) break;
        const parent = dirname(current);
        if (parent === current) break; // reached the root; first not on path
        current = parent;
      }
      await syncDirectory(dirname(first));
      for (const directory of chain.reverse()) await syncDirectory(directory);
    }
    const path = join(this.#directory, fileNameFor(streamId));
    const releaseLock = await acquireLock(
      `${path}.lock`,
      streamId,
      this.#staleLockMs,
    );

    let file: FileHandle | undefined;
    try {
      let data: Buffer;
      let isNewFile = false;
      try {
        data = await readFile(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        data = Buffer.alloc(0);
        isNewFile = true;
      }

      const parsed = parseRecords(data, streamId, this.#version, this.#codec);
      // Drop an interrupted tail before appending, otherwise the next record
      // would be concatenated onto the partial line. Windows rejects truncate
      // on an append-mode handle, so do it through a separate read/write handle.
      if (parsed.validBytes < data.length) {
        const truncating = await open(path, "r+");
        try {
          await truncating.truncate(parsed.validBytes);
          // Truncation is an inode change, so fsync the file (not the
          // directory) to make the discarded tail stay discarded.
          await truncating.sync();
        } finally {
          await truncating.close();
        }
      }
      const opened = await open(path, "a", PRIVATE_FILE_MODE);
      file = opened;
      // A newly created log file is only durable once its directory entry is.
      if (isNewFile) await syncDirectory(this.#directory);
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
  /** Length of the prefix of #records covered by a successful fsync. */
  #durableCount: number;
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
    // Records parsed at open came from the file, so they are already on disk.
    this.#durableCount = records.length;
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
    // Every record counted here was fully written before this synchronous
    // read, so the sync below covers all of them. Records appended after this
    // point are not covered and stay hidden from read() until a later flush.
    const covered = this.#records.length;
    try {
      await this.#file.sync();
    } catch (error) {
      this.#poison(toError(error));
      throw error;
    }
    this.#durableCount = Math.max(this.#durableCount, covered);
  }

  /**
   * Returns only records covered by a successful sync (records loaded at open
   * are already on disk). Appended-but-unflushed records are excluded, so a
   * caller can never treat history as saved that a crash could still lose.
   * Call `flush()` first to read your own latest appends.
   */
  read(): AsyncIterable<EventLogRecord<TEvent>> {
    // Capture the snapshot at call time; later appends stay invisible.
    const snapshot = this.#records.slice(0, this.#durableCount);
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
        if (this.#poisoned === undefined) {
          const covered = this.#records.length;
          await this.#file.sync();
          this.#durableCount = Math.max(this.#durableCount, covered);
        }
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
