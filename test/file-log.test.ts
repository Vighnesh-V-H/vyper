import { describe, expect, test } from "bun:test";
import {
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
      expect(first.parentId).toBeNull();
      expect(second.id).not.toBe(first.id);
      expect(second.parentId).toBe(first.id);
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

  test("serializes parent links for concurrent appends", async () => {
    await withDirectory(async (directory) => {
      const handle = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      const [first, second, third] = await Promise.all([
        handle.append({ value: "one" }),
        handle.append({ value: "two" }),
        handle.append({ value: "three" }),
      ]);
      await handle.flush();

      expect(second?.parentId).toBe(first?.id);
      expect(third?.parentId).toBe(second?.id);
      await handle.close();

      const reopened = await new FileEventLog<Payload>({
        directory,
        codec,
      }).open(streamId);
      expect(
        (await collect(reopened.read())).map((record) => record.parentId),
      ).toEqual([null, first?.id, second?.id]);
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

  test(
    "rejects a complete unterminated final record with the wrong parent",
    async () => {
      await withDirectory(async (directory) => {
        const path = join(directory, "stream-1.jsonl");
        const record = {
          id: "stream-1:1",
          parentId: "missing-parent",
          version: 1,
          streamId: "stream-1",
          sequence: 1,
          timestamp: 1,
          event: { value: "one" },
        };
        await writeFile(path, JSON.stringify(record), "utf8");

        await expect(
          new FileEventLog<Payload>({ directory, codec }).open(streamId),
        ).rejects.toThrow(/does not link to its preceding entry/);
        expect(await readFile(path, "utf8")).toBe(JSON.stringify(record));
      });
    },
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
