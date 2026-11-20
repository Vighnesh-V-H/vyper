import { describe, expect, test } from "bun:test";
import { ErrorCode } from "../src/errors";
import { MemoryEventLog } from "../src/event-log/memory";
import {
  persistedModelResponse,
  SessionEventCodec,
} from "../src/session/codec";
import { SessionLog } from "../src/session/log";
import { AgentErrorStage, AgentStatus } from "../src/types/agent";
import type { TokenUsage } from "../src/types/context";
import type { EventLogRecord } from "../src/types/event-log";
import {
  asEventLogStreamId,
  asSessionId,
  asToolCallId,
  asTurnId,
} from "../src/types/ids";
import type { Message } from "../src/types/message";
import type {
  PersistedModelResponse,
  SessionEvent,
  SessionTurnCommittedEvent,
} from "../src/types/session";
import { SessionEventType } from "../src/types/session";

const sessionId = asSessionId("session-1");
const usage = (inputTokens = 1, outputTokens = 1): TokenUsage => ({
  inputTokens,
  outputTokens,
});

function response(
  text: string,
  values: TokenUsage = usage(),
): PersistedModelResponse {
  return persistedModelResponse({
    text,
    toolCalls: [],
    usage: values,
  });
}

function finished(
  turnId: ReturnType<typeof asTurnId>,
  output: string,
  messages: readonly Message[],
  values: TokenUsage = usage(),
): SessionTurnCommittedEvent {
  return {
    type: SessionEventType.TurnFinished,
    turnId,
    status: AgentStatus.Completed,
    output,
    steps: 1,
    usage: values,
    messages,
  };
}

async function openSession(
  log = new MemoryEventLog<SessionEvent>(),
  now: () => number = () => 1_000,
): Promise<SessionLog> {
  return SessionLog.open({
    log,
    sessionId,
    model: "test-model",
    instructions: "be useful",
    cwd: "/work",
    now,
  });
}

describe("persisted session log", () => {
  test("open writes and flushes a header at sequence 1 before returning", async () => {
    const session = await openSession();
    const records: EventLogRecord<SessionEvent>[] = [];
    for await (const record of session.read()) records.push(record);

    expect(records).toHaveLength(1);
    expect(records[0]?.sequence).toBe(1);
    expect(records[0]?.event).toEqual({
      type: SessionEventType.Header,
      sessionId,
      version: 1,
      timestamp: 1_000,
      model: "test-model",
      instructions: "be useful",
      cwd: "/work",
    });
  });

  test("metadata changes append events and never rewrite the header", async () => {
    const session = await openSession();
    await session.append({
      type: SessionEventType.MetadataChanged,
      cwd: "/next",
      appConfig: { theme: "dark" },
    });
    await session.flush();

    const snapshot = await session.snapshot();
    expect(snapshot.header?.cwd).toBe("/work");
    expect(snapshot.metadata?.cwd).toBe("/next");
    expect(snapshot.metadata?.model).toBe("test-model");
    expect(snapshot.metadata?.appConfig).toEqual({ theme: "dark" });
  });

  test("resume preserves the original header instead of writing another", async () => {
    const log = new MemoryEventLog<SessionEvent>();
    const first = await openSession(log);
    await first.append({
      type: SessionEventType.MetadataChanged,
      model: "updated-model",
    });
    await first.close();

    const resumed = await SessionLog.open({
      log,
      sessionId,
      model: "ignored-on-resume",
      cwd: "/ignored",
      now: () => 9_999,
    });
    const snapshot = await resumed.snapshot();
    expect(snapshot.header?.model).toBe("test-model");
    expect(snapshot.header?.timestamp).toBe(1_000);
    expect(snapshot.metadata?.model).toBe("updated-model");

    const records: EventLogRecord<SessionEvent>[] = [];
    for await (const record of resumed.read()) records.push(record);
    expect(records[0]?.sequence).toBe(1);
    expect(records.filter((record) => record.event.type === SessionEventType.Header)).toHaveLength(1);
  });

  test("read is a bounded snapshot and does not wait for later appends", async () => {
    const log = new MemoryEventLog<number>();
    const handle = await log.open(asEventLogStreamId("stream-1"));
    await handle.append(1);

    const firstRead = handle.read();
    await handle.append(2);
    await handle.flush();

    const first: number[] = [];
    for await (const record of firstRead) first.push(record.event);
    expect(first).toEqual([1]);

    const second: number[] = [];
    for await (const record of handle.read()) second.push(record.event);
    expect(second).toEqual([1, 2]);
    expect(handle.nextSequence).toBe(3);
  });

  test("TurnFinished fields are checked against ModelResponded and ToolCompleted", async () => {
    const session = await openSession();
    const turnId = asTurnId("turn-1");
    await session.append({
      type: SessionEventType.TurnStarted,
      turnId,
      prompt: "hello",
    });
    const responded = await session.append({
      type: SessionEventType.ModelResponded,
      turnId,
      step: 1,
      response: persistedModelResponse({
        text: "",
        toolCalls: [
          { id: asToolCallId("call-1"), name: "clock", arguments: {} },
        ],
      }),
    });
    await session.append({
      type: SessionEventType.ToolCompleted,
      turnId,
      step: 1,
      result: {
        callId: asToolCallId("call-1"),
        name: "clock",
        content: "12:00",
        isError: false,
        durationMs: 1,
      },
    });
    expect(responded.sequence).toBe(3);

    await expect(
      session.append({
        ...finished(turnId, "wrong", []),
        steps: 2,
      }),
    ).rejects.toThrow(/steps=/);

    // The mismatch poisons the handle rather than leaving a history that
    // replay would trust.
    await expect(
      session.append({ type: SessionEventType.Reset }),
    ).rejects.toThrow(/poisoned/);
    await expect(session.flush()).rejects.toThrow(/poisoned/);
  });

  test("retractions exclude a turn from projection but keep its records", async () => {
    const session = await openSession();
    const firstTurn = asTurnId("turn-1");
    const secondTurn = asTurnId("turn-2");
    const firstMessages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ];
    const secondMessages: Message[] = [
      ...firstMessages,
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ];

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: firstTurn,
      prompt: "first",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: firstTurn,
      step: 1,
      response: response("one"),
    });
    await session.append(finished(firstTurn, "one", firstMessages));

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: secondTurn,
      prompt: "second",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: secondTurn,
      step: 1,
      response: response("two"),
    });
    const secondFinish = await session.append(
      finished(secondTurn, "two", secondMessages),
    );
    await session.append({
      type: SessionEventType.Retraction,
      retractsSequence: secondFinish.sequence,
      reason: "retry",
    });
    await session.flush();

    const snapshot = await session.snapshot();
    expect(snapshot.messages).toEqual(firstMessages);

    const records: EventLogRecord<SessionEvent>[] = [];
    for await (const record of session.read()) records.push(record);
    expect(records).toHaveLength(8);
    expect(
      records.some(
        (record) =>
          record.event.type === SessionEventType.Retraction &&
          record.event.retractsSequence === secondFinish.sequence,
      ),
    ).toBe(true);
  });

  test("failed turns can be retracted before they ever finish", async () => {
    const session = await openSession();
    const goodTurn = asTurnId("turn-good");
    const failedTurn = asTurnId("turn-failed");
    const messages: Message[] = [
      { role: "user", content: "good" },
      { role: "assistant", content: "ok" },
    ];

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: goodTurn,
      prompt: "good",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: goodTurn,
      step: 1,
      response: response("ok"),
    });
    await session.append(finished(goodTurn, "ok", messages));

    const failedStart = await session.append({
      type: SessionEventType.TurnStarted,
      turnId: failedTurn,
      prompt: "bad",
    });
    await session.append({
      type: SessionEventType.Error,
      turnId: failedTurn,
      step: 1,
      stage: AgentErrorStage.Model,
      error: { name: "Error", message: "boom" },
    });
    await session.append({
      type: SessionEventType.Retraction,
      retractsSequence: failedStart.sequence,
      reason: "failed turn",
    });
    await session.flush();

    const snapshot = await session.snapshot();
    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.interruptedTurnId).toBeUndefined();
  });

  test("compaction replays as a summary plus events after the cutoff", async () => {
    const session = await openSession();
    const firstTurn = asTurnId("turn-1");
    const secondTurn = asTurnId("turn-2");
    const oldMessages: Message[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
    ];
    const newMessages: Message[] = [
      { role: "user", content: "new" },
      { role: "assistant", content: "new answer" },
    ];

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: firstTurn,
      prompt: "old",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: firstTurn,
      step: 1,
      response: response("old answer"),
    });
    const firstFinish = await session.append(
      finished(firstTurn, "old answer", oldMessages),
    );
    const compaction = await session.append({
      type: SessionEventType.Compaction,
      summary: "the old answer",
      cutoffSequence: firstFinish.sequence,
      tokensBefore: 500,
      at: 2_000,
    });

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: secondTurn,
      prompt: "new",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: secondTurn,
      step: 1,
      response: response("new answer"),
    });
    await session.append(finished(secondTurn, "new answer", newMessages));
    await session.flush();

    const snapshot = await session.snapshot();
    expect(snapshot.summary).toBe("the old answer");
    expect(snapshot.cutoffSequence).toBe(firstFinish.sequence);
    expect(snapshot.messages).toEqual(newMessages);
    expect(compaction.sequence).toBeGreaterThan(firstFinish.sequence);
  });

  test("compaction keeps events recorded after the cutoff but before the entry", async () => {
    const session = await openSession();
    const summarizedTurn = asTurnId("turn-old");
    const keptTurn = asTurnId("turn-kept");
    const oldMessages: Message[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
    ];
    const keptMessages: Message[] = [
      { role: "user", content: "kept" },
      { role: "assistant", content: "kept answer" },
    ];

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: summarizedTurn,
      prompt: "old",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: summarizedTurn,
      step: 1,
      response: response("old answer"),
    });
    const oldFinish = await session.append(
      finished(summarizedTurn, "old answer", oldMessages),
    );
    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: keptTurn,
      prompt: "kept",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId: keptTurn,
      step: 1,
      response: response("kept answer"),
    });
    await session.append(finished(keptTurn, "kept answer", keptMessages));
    await session.append({
      type: SessionEventType.Compaction,
      summary: "the old answer",
      cutoffSequence: oldFinish.sequence,
      tokensBefore: 500,
      at: 2_000,
    });
    await session.flush();

    const snapshot = await session.snapshot();
    expect(snapshot.summary).toBe("the old answer");
    expect(snapshot.cutoffSequence).toBe(oldFinish.sequence);
    expect(snapshot.messages).toEqual(keptMessages);
  });
});

describe("SessionEventCodec", () => {
  const codec = new SessionEventCodec();

  test("decodes to a detached persisted view with JSON object arguments", () => {
    const input = {
      type: SessionEventType.ModelResponded,
      turnId: asTurnId("turn-1"),
      step: 1,
      response: {
        text: "calling",
        toolCalls: [
          {
            id: asToolCallId("call-1"),
            name: "echo",
            arguments: { nested: { value: 1 } },
          },
        ],
      },
    };

    const decoded = codec.decode(input);
    if (decoded.type !== SessionEventType.ModelResponded) {
      throw new Error("unexpected event type");
    }
    expect(decoded.response.toolCalls[0]?.arguments).toEqual({
      nested: { value: 1 },
    });

    input.response.toolCalls[0]!.arguments.nested.value = 2;
    expect(decoded.response.toolCalls[0]?.arguments).toEqual({
      nested: { value: 1 },
    });
  });

  test("rejects non-JSON, non-finite, exotic, and cyclic arguments", () => {
    const base = {
      type: SessionEventType.ModelResponded,
      turnId: "turn-1",
      step: 1,
      response: {
        toolCalls: [{ id: "call-1", name: "echo", arguments: {} }],
      },
    };

    const withArguments = (args: Record<string, unknown>): unknown => ({
      ...base,
      response: {
        toolCalls: [{ id: "call-1", name: "echo", arguments: args }],
      },
    });

    expect(() => codec.decode(withArguments({ value: undefined }))).toThrow(
      /JSON-safe/,
    );
    expect(() => codec.decode(withArguments({ value: Number.NaN }))).toThrow(
      /finite number/,
    );
    expect(() => codec.decode(withArguments({ value: new Date() }))).toThrow(
      /plain JSON object/,
    );
    expect(() => codec.decode(withArguments({ value: () => 1 }))).toThrow(
      /JSON-safe/,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => codec.decode(withArguments(cyclic))).toThrow(/cycles/);
  });

  test("branded ids are assignable to string at runtime", () => {
    const toolCallId = asToolCallId("call-1");
    expect(String(toolCallId)).toBe("call-1");
    expect(typeof toolCallId).toBe("string");
    expect(String(ErrorCode.EventLogInvalid)).toBe("event-log/invalid");
  });
});
