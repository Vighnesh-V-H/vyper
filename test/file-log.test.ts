import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogError } from "../src/errors";
import { FileEventLog } from "../src/event-log/file";
import type { EventLogCodec, EventLogRecord } from "../src/types/event-log";
import { asEventLogStreamId } from "../src/types/ids";

interface Payload {
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const codec: EventLogCodec<Payload> = {
  version: 1,
  decode(value) {
    if (!isRecord(value) || typeof value.value !== "string") {
      throw new EventLogError("payload must be an object with a string value");
    }
    return { value: value.value };
  },
};

const streamId = asEventLogStreamId("stream-1");

async function collect(
  iterable: AsyncIterable<EventLogRecord<Payload>>,
): Promise<EventLogRecord<Payload>[]> {
  const records: EventLogRecord<Payload>[] = [];
  for await (const record of iterable) records.push(record);
  return records;
}

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "vyper-event-log-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("FileEventLog", () => {
  test("writes durable JSONL records and reopens with the next sequence", async () => {
    await withDirectory(async (directory) => {
      const log = new FileEventLog<Payload>({ directory, codec });
      const handle = await log.open(streamId);

      const first = await handle.append({ value: "one" });
      const second = await handle.append({ value: "two" });
      await handle.flush();

      expect(first.sequence).toBe(1);
      expect(second.sequence).toBe(2);
      expect(handle.nextSequence).toBe(3);
      expect(await collect(handle.read())).toEqual([first, second]);
      await handle.close();

      const reopened = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(reopened.nextSequence).toBe(3);
      const records = await collect(reopened.read());
      expect(records.map((record) => record.event.value)).toEqual([
        "one",
        "two",
      ]);
      expect(records.map((record) => record.sequence)).toEqual([1, 2]);
      await reopened.close();
    });
  });

  test("read is a bounded snapshot at call time", async () => {
    await withDirectory(async (directory) => {
      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);

      await handle.append({ value: "one" });
      await handle.flush();
      const early = handle.read();

      await handle.append({ value: "two" });
      await handle.flush();

      expect((await collect(early)).map((record) => record.event.value)).toEqual(
        ["one"],
      );
      expect(
        (await collect(handle.read())).map((record) => record.event.value),
      ).toEqual(["one", "two"]);
      await handle.close();
    });
  });

  test("rejects malformed lines instead of silently skipping history", async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, "broken.jsonl"), "not json\n", "utf8");
      const log = new FileEventLog<Payload>({ directory, codec });
      await expect(log.open(asEventLogStreamId("broken"))).rejects.toThrow(
        /not valid JSON/,
      );
    });
  });

  test("rejects version mismatches and non-contiguous sequences", async () => {
    await withDirectory(async (directory) => {
      const base = {
        version: 1,
        streamId: "stream-1",
        sequence: 1,
        timestamp: 1,
        event: { value: "one" },
      };

      await writeFile(
        join(directory, "stream-1.jsonl"),
        `${JSON.stringify({ ...base, version: 2 })}\n`,
        "utf8",
      );
      const log = new FileEventLog<Payload>({ directory, codec });
      await expect(log.open(streamId)).rejects.toThrow(/unsupported version/);

      await writeFile(
        join(directory, "stream-1.jsonl"),
        `${JSON.stringify({ ...base, sequence: 2 })}\n`,
        "utf8",
      );
      await expect(log.open(streamId)).rejects.toThrow(
        /expected 1/,
      );
    });
  });

  test("keeps stream ids inside the configured directory", async () => {
    await withDirectory(async (directory) => {
      const log = new FileEventLog<Payload>({ directory, codec });
      const handle = await log.open(asEventLogStreamId("../escape"));
      await handle.append({ value: "safe" });
      await handle.flush();
      await handle.close();

      const entries = await readdir(directory);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.includes("/")).toBe(false);
      expect(entries[0]?.includes("\\")).toBe(false);
    });
  });

  test("rejects appends after close", async () => {
    await withDirectory(async (directory) => {
      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      await handle.close();
      await expect(handle.append({ value: "late" })).rejects.toThrow(
        /closed/,
      );
    });
  });

  test("reports and retries a failed lock release", async () => {
    await withDirectory(async (directory) => {
      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      const lockPath = join(directory, "stream-1.jsonl.lock");

      // Make the unlock fail by replacing the lock file with a directory.
      await rm(lockPath);
      await mkdir(lockPath);
      await expect(handle.close()).rejects.toThrow();

      // The handle stays retryable, and appends remain rejected in between.
      await expect(handle.append({ value: "late" })).rejects.toThrow(/closing/);
      await rm(lockPath, { recursive: true, force: true });
      await handle.close();
      await expect(handle.append({ value: "late" })).rejects.toThrow(
        /closed/,
      );
    });
  });

  test("rejects a second writer until the first handle closes", async () => {
    await withDirectory(async (directory) => {
      const first = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);

      await expect(
        new FileEventLog<Payload>({ directory, codec }).open(streamId),
      ).rejects.toThrow(/already open by another writer/);

      await first.close();
      expect(
        (await readdir(directory)).some((name) => name.endsWith(".lock")),
      ).toBe(false);

      const second = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      await second.close();
    });
  });

  test("recovers an abandoned lock file", async () => {
    await withDirectory(async (directory) => {
      const lockPath = join(directory, "stream-1.jsonl.lock");
      await writeFile(lockPath, "", "utf8");
      const old = new Date(Date.now() - 120_000);
      await utimes(lockPath, old, old);

      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      await handle.append({ value: "recovered" });
      await handle.flush();
      await handle.close();

      const reopened = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(
        (await collect(reopened.read())).map((record) => record.event.value),
      ).toEqual(["recovered"]);
      await reopened.close();
    });
  });

  test("recovers an abandoned recovery guard and lock together", async () => {
    await withDirectory(async (directory) => {
      const lockPath = join(directory, "stream-1.jsonl.lock");
      const guardPath = `${lockPath}.guard.0`;
      await writeFile(lockPath, "", "utf8");
      await writeFile(guardPath, "", "utf8");
      const old = new Date(Date.now() - 120_000);
      await utimes(lockPath, old, old);
      await utimes(guardPath, old, old);

      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      await handle.append({ value: "recovered" });
      await handle.flush();
      await handle.close();

      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".lock")),
      ).toEqual([]);
    });
  });

  test("allows only one writer when concurrent opens recover an abandoned guard and lock", async () => {
    await withDirectory(async (directory) => {
      const old = new Date(Date.now() - 120_000);
      const log = new FileEventLog<Payload>({ directory, codec });

      for (let iteration = 0; iteration < 10; iteration += 1) {
        const stream = asEventLogStreamId(`stream-${iteration}`);
        const lockPath = join(directory, `stream-${iteration}.jsonl.lock`);
        const guardPath = `${lockPath}.guard.0`;
        await writeFile(lockPath, "", "utf8");
        await writeFile(guardPath, "", "utf8");
        await utimes(lockPath, old, old);
        await utimes(guardPath, old, old);

        const results = await Promise.allSettled([
          log.open(stream),
          log.open(stream),
          log.open(stream),
        ]);
        const opened = results.filter(
          (result) => result.status === "fulfilled",
        );
        expect(opened).toHaveLength(1);

        const winner = opened[0];
        if (winner?.status !== "fulfilled") throw new Error("missing winner");
        await winner.value.close();

        for (const result of results) {
          if (result.status === "rejected") {
            expect(String(result.reason)).toMatch(/another writer/);
          }
        }
      }
    });
  });

  test("recovers an interrupted final record and truncates it before appending", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "stream-1.jsonl");
      const first = {
        version: 1,
        streamId: "stream-1",
        sequence: 1,
        timestamp: 1,
        event: { value: "one" },
      };
      await writeFile(
        path,
        `${JSON.stringify(first)}\n{"version":1,"streamId":"stream-1"`,
        "utf8",
      );

      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(
        (await collect(handle.read())).map((record) => record.event.value),
      ).toEqual(["one"]);

      const second = await handle.append({ value: "two" });
      expect(second.sequence).toBe(2);
      await handle.flush();
      await handle.close();

      const reopened = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(
        (await collect(reopened.read())).map((record) => record.event.value),
      ).toEqual(["one", "two"]);
      await reopened.close();

      const contents = await readFile(path, "utf8");
      expect(contents.endsWith("\n")).toBe(true);
      expect(contents).not.toContain('"streamId":"stream-1"{"');
    });
  });

  test("terminates a complete final record that lost its newline", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "stream-1.jsonl");
      const first = {
        version: 1,
        streamId: "stream-1",
        sequence: 1,
        timestamp: 1,
        event: { value: "one" },
      };
      await writeFile(path, JSON.stringify(first), "utf8");

      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(
        (await collect(handle.read())).map((record) => record.event.value),
      ).toEqual(["one"]);

      const second = await handle.append({ value: "two" });
      expect(second.sequence).toBe(2);
      await handle.flush();
      await handle.close();

      const reopened = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(
        (await collect(reopened.read())).map((record) => record.event.value),
      ).toEqual(["one", "two"]);
      await reopened.close();
    });
  });

  test("rejects an incompatible final record without a newline without truncating it", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "stream-1.jsonl");
      const base = {
        version: 1,
        streamId: "stream-1",
        sequence: 1,
        timestamp: 1,
        event: { value: "one" },
      };
      const cases: ReadonlyArray<{
        readonly record: Record<string, unknown>;
        readonly pattern: RegExp;
      }> = [
        {
          record: { ...base, version: 2 },
          pattern: /unsupported version/,
        },
        {
          record: { ...base, sequence: 2 },
          pattern: /expected 1/,
        },
        {
          record: { ...base, event: { value: 42 } },
          pattern: /payload must be an object with a string value/,
        },
      ];
      const log = new FileEventLog<Payload>({ directory, codec });

      for (const { record, pattern } of cases) {
        const contents = JSON.stringify(record);
        await writeFile(path, contents, "utf8");
        await expect(log.open(streamId)).rejects.toThrow(pattern);
        expect(await readFile(path, "utf8")).toBe(contents);
      }
    });
  });

  test("validates appended events through the codec before writing", async () => {
    await withDirectory(async (directory) => {
      const finiteCodec: EventLogCodec<number> = {
        version: 1,
        decode(value) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new EventLogError("value must be a finite number");
          }
          return value;
        },
      };
      const stream = asEventLogStreamId("numbers");
      const log = new FileEventLog<number>({
        directory,
        codec: finiteCodec,
      });
      const handle = await log.open(stream);

      await expect(handle.append(Number.NaN)).rejects.toThrow(/finite number/);
      const first = await handle.append(1);
      expect(first.sequence).toBe(1);
      await handle.flush();
      await handle.close();

      const reopened = await log.open(stream);
      const values: number[] = [];
      for await (const record of reopened.read()) values.push(record.event);
      expect(values).toEqual([1]);
      await reopened.close();
    });
  });
});
