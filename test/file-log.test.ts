import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
});
