import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEventLog } from "../src/event-log/file";
import { MemoryEventLog } from "../src/event-log/memory";
import { SessionEventCodec } from "../src/session/codec";
import { ChatSession } from "../src/session/chat";
import { SessionLog } from "../src/session/log";
import { AgentErrorStage, AgentEventType, AgentStatus } from "../src/types/agent";
import type {
  AgentEvent,
  AgentResult,
  AgentRunOptions,
} from "../src/types/agent";
import type { TokenUsage } from "../src/types/context";
import type { EventLogRecord } from "../src/types/event-log";
import {
  asSessionId,
  asToolCallId,
  asTurnId,
} from "../src/types/ids";
import type { Message, ToolCall } from "../src/types/message";
import type { ChatAgent } from "../src/types/session";
import type { SessionEvent } from "../src/types/session";
import { SessionEventType } from "../src/types/session";

const sessionId = asSessionId("chat-session");
const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

function modelEvent(
  step: number,
  text: string,
  toolCalls: readonly ToolCall[] = [],
  usage: TokenUsage = { inputTokens: 1, outputTokens: 1 },
): AgentEvent {
  return {
    type: AgentEventType.ModelResponse,
    step,
    response: { text, toolCalls: [...toolCalls], usage },
  };
}

function completed(
  messages: readonly Message[],
  output: string,
  steps = 1,
  usage: TokenUsage = zeroUsage(),
): AgentResult {
  return {
    status: AgentStatus.Completed,
    messages,
    output,
    steps,
    usage,
  };
}

function failed(
  messages: readonly Message[],
  output: string,
): AgentResult {
  return {
    status: AgentStatus.Error,
    stage: AgentErrorStage.Model,
    error: new Error(output),
    messages,
    output,
    steps: 1,
    usage: zeroUsage(),
  };
}

function aborted(
  messages: readonly Message[],
  output: string,
): AgentResult {
  return {
    status: AgentStatus.Aborted,
    messages,
    output,
    steps: 1,
    usage: zeroUsage(),
  };
}

interface ScriptedTurn {
  readonly result: AgentResult;
  readonly events: readonly AgentEvent[];
}

interface ScriptedAgent extends ChatAgent {
  readonly runs: (string | readonly Message[])[];
}

function scriptedAgent(turns: readonly ScriptedTurn[]): ScriptedAgent {
  const runs: (string | readonly Message[])[] = [];
  let index = 0;
  return {
    runs,
    async run(input, options: AgentRunOptions | undefined) {
      runs.push(input);
      const turn = turns[index];
      index += 1;
      if (turn === undefined) throw new Error("unexpected agent run");
      for (const event of turn.events) {
        for (const interceptor of options?.interceptors ?? []) {
          await interceptor(event);
        }
      }
      return turn.result;
    },
  };
}

async function openSession(
  storage = new MemoryEventLog<SessionEvent>(),
): Promise<{
  readonly session: SessionLog;
  readonly storage: MemoryEventLog<SessionEvent>;
}> {
  const session = await SessionLog.open({
    log: storage,
    sessionId,
    model: "test-model",
    cwd: "/work",
    now: () => 1_000,
  });
  return { session, storage };
}

async function collect(
  iterable: AsyncIterable<EventLogRecord<SessionEvent>>,
): Promise<EventLogRecord<SessionEvent>[]> {
  const records: EventLogRecord<SessionEvent>[] = [];
  for await (const record of iterable) records.push(record);
  return records;
}

function turnMessages(
  prompt: string,
  answer: string,
  previous: readonly Message[] = [],
): Message[] {
  return [
    ...previous,
    { role: "user", content: prompt },
    { role: "assistant", content: answer },
  ];
}

describe("persisted ChatSession", () => {
  test("records the full turn lifecycle and derives TurnFinished fields", async () => {
    const messages = turnMessages("hello", "done");
    const toolCallId = asToolCallId("call-1");
    const agent = scriptedAgent([
      {
        events: [
          { type: AgentEventType.StepStart, step: 1 },
          {
            type: AgentEventType.ContextPrepared,
            step: 1,
            compacted: false,
            tokensEstimated: 5,
          },
          modelEvent(
            1,
            "",
            [{ id: toolCallId, name: "clock", arguments: { zone: "UTC" } }],
            { inputTokens: 10, outputTokens: 2 },
          ),
          {
            type: AgentEventType.ToolStart,
            step: 1,
            callId: toolCallId,
            name: "clock",
          },
          {
            type: AgentEventType.ToolResult,
            step: 1,
            result: {
              callId: toolCallId,
              name: "clock",
              content: "12:00",
              isError: false,
              durationMs: 5,
            },
          },
          modelEvent(2, "done", [], { inputTokens: 20, outputTokens: 3 }),
        ],
        result: completed(messages, "done", 2, {
          inputTokens: 30,
          outputTokens: 5,
        }),
      },
    ]);
    const { session } = await openSession();
    let turn = 0;
    const chat = await ChatSession.open({
      agent,
      session,
      createTurnId: () => asTurnId(`turn-${++turn}`),
    });

    const result = await chat.ask("hello");
    expect(result.status).toBe(AgentStatus.Completed);

    const records = await collect(session.read());
    expect(records.map((record) => record.event.type)).toEqual([
      SessionEventType.Header,
      SessionEventType.TurnStarted,
      SessionEventType.StepStarted,
      SessionEventType.ContextPrepared,
      SessionEventType.ModelResponded,
      SessionEventType.ToolStarted,
      SessionEventType.ToolCompleted,
      SessionEventType.ModelResponded,
      SessionEventType.TurnFinished,
    ]);

    const finished = records.at(-1)?.event;
    if (finished?.type !== SessionEventType.TurnFinished) {
      throw new Error("expected TurnFinished");
    }
    expect(finished.output).toBe("done");
    expect(finished.steps).toBe(2);
    expect(finished.usage).toEqual({ inputTokens: 30, outputTokens: 5 });
    if (!("messages" in finished)) throw new Error("expected committed turn");
    expect(finished.messages).toEqual(messages);

    const snapshot = await session.snapshot();
    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.interruptedTurnId).toBeUndefined();
  });

  test("records and retracts a step-0 configuration failure without corrupting the log", async () => {
    const error = new Error("bad configuration");
    const agent = scriptedAgent([
      {
        events: [
          {
            type: AgentEventType.Error,
            step: 0,
            stage: AgentErrorStage.Configuration,
            error,
          },
        ],
        result: {
          status: AgentStatus.Error,
          stage: AgentErrorStage.Configuration,
          error,
          messages: [],
          output: error.message,
          steps: 0,
          usage: zeroUsage(),
        },
      },
    ]);
    const { session, storage } = await openSession();
    const chat = await ChatSession.open({
      agent,
      session,
      createTurnId: () => asTurnId("turn-config"),
    });

    const result = await chat.ask("hello");
    expect(result.status).toBe(AgentStatus.Error);
    expect(chat.messages).toEqual([]);
    await chat.close();

    // Reopening decodes every stored record, including the step-0 Error.
    const reopened = await SessionLog.open({
      log: storage,
      sessionId,
      model: "test-model",
      cwd: "/work",
    });
    const snapshot = await reopened.snapshot();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.interruptedTurnId).toBeUndefined();
    const records = await collect(reopened.read());
    expect(records.at(-1)?.event.type).toBe(SessionEventType.Retraction);
    await reopened.close();
  });

  test("retracts failed turns so a retry starts from the last committed history", async () => {
    const firstMessages = turnMessages("first", "one");
    const failedMessages = [
      ...firstMessages,
      { role: "user" as const, content: "second" },
    ];
    const thirdMessages = turnMessages("third", "three", firstMessages);
    const agent = scriptedAgent([
      {
        events: [modelEvent(1, "one")],
        result: completed(firstMessages, "one"),
      },
      {
        events: [modelEvent(1, "failed")],
        result: failed(failedMessages, "model failed"),
      },
      {
        events: [modelEvent(1, "three")],
        result: completed(thirdMessages, "three"),
      },
    ]);
    const { session } = await openSession();
    let turn = 0;
    const chat = await ChatSession.open({
      agent,
      session,
      createTurnId: () => asTurnId(`turn-${++turn}`),
    });

    await chat.ask("first");
    const failure = await chat.ask("second");
    expect(failure.status).toBe(AgentStatus.Error);
    expect(chat.messages).toEqual(firstMessages);

    const failedSnapshot = await session.snapshot();
    expect(failedSnapshot.messages).toEqual(firstMessages);
    expect(failedSnapshot.interruptedTurnId).toBeUndefined();
    const records = await collect(session.read());
    expect(records.at(-1)?.event.type).toBe(SessionEventType.Retraction);

    await chat.ask("third");
    expect(agent.runs[2]).toEqual([
      ...firstMessages,
      { role: "user", content: "third" },
    ]);
    expect(chat.messages).toEqual(thirdMessages);
  });

  test("records an aborted turn without committing its history", async () => {
    const agent = scriptedAgent([
      {
        events: [modelEvent(1, "partial")],
        result: aborted([], "aborted"),
      },
    ]);
    const { session } = await openSession();
    const chat = await ChatSession.open({
      agent,
      session,
      createTurnId: () => asTurnId("turn-aborted"),
    });

    const result = await chat.ask("slow");
    expect(result.status).toBe(AgentStatus.Aborted);
    expect(chat.messages).toEqual([]);

    const records = await collect(session.read());
    const finished = records.at(-1)?.event;
    if (finished?.type !== SessionEventType.TurnFinished) {
      throw new Error("expected TurnFinished");
    }
    expect(finished.status).toBe(AgentStatus.Aborted);
    expect(finished.output).toBe("partial");
    expect(finished.steps).toBe(1);

    const snapshot = await session.snapshot();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.interruptedTurnId).toBeUndefined();
  });

  test("resumes the committed conversation on reopen", async () => {
    const firstMessages = turnMessages("first", "one");
    const firstAgent = scriptedAgent([
      {
        events: [modelEvent(1, "one")],
        result: completed(firstMessages, "one"),
      },
    ]);
    const { session, storage } = await openSession();
    const firstChat = await ChatSession.open({
      agent: firstAgent,
      session,
      createTurnId: () => asTurnId("turn-1"),
    });
    await firstChat.ask("first");
    await firstChat.close();

    const secondMessages = turnMessages("second", "two", firstMessages);
    const secondAgent = scriptedAgent([
      {
        events: [modelEvent(1, "two")],
        result: completed(secondMessages, "two"),
      },
    ]);
    const reopened = await SessionLog.open({
      log: storage,
      sessionId,
      model: "ignored",
      cwd: "/ignored",
    });
    const secondChat = await ChatSession.open({
      agent: secondAgent,
      session: reopened,
      createTurnId: () => asTurnId("turn-2"),
    });
    expect(secondChat.messages).toEqual(firstMessages);

    await secondChat.ask("second");
    expect(secondAgent.runs[0]).toEqual([
      ...firstMessages,
      { role: "user", content: "second" },
    ]);
    expect(secondChat.messages).toEqual(secondMessages);
    expect((await reopened.snapshot()).messages).toEqual(secondMessages);
    await secondChat.close();
  });

  test("persists and resumes through the file-backed event log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vyper-chat-"));
    const codec = new SessionEventCodec();
    const openLog = () =>
      new FileEventLog<SessionEvent>({ directory, codec });

    try {
      const firstMessages = turnMessages("first", "one");
      const first = await SessionLog.open({
        log: openLog(),
        codec,
        sessionId,
        model: "test-model",
        cwd: "/work",
        now: () => 1_000,
      });
      const firstChat = await ChatSession.open({
        agent: scriptedAgent([
          {
            events: [modelEvent(1, "one")],
            result: completed(firstMessages, "one"),
          },
        ]),
        session: first,
        createTurnId: () => asTurnId("turn-file-1"),
      });
      await firstChat.ask("first");
      await firstChat.close();

      const resumed = await SessionLog.open({
        log: openLog(),
        codec,
        sessionId,
        model: "ignored",
        cwd: "/ignored",
        now: () => 9_999,
      });
      const secondMessages = turnMessages("second", "two", firstMessages);
      const secondAgent = scriptedAgent([
        {
          events: [modelEvent(1, "two")],
          result: completed(secondMessages, "two"),
        },
      ]);
      const secondChat = await ChatSession.open({
        agent: secondAgent,
        session: resumed,
        createTurnId: () => asTurnId("turn-file-2"),
      });

      expect(secondChat.messages).toEqual(firstMessages);
      await secondChat.ask("second");
      expect(secondAgent.runs[0]).toEqual([
        ...firstMessages,
        { role: "user", content: "second" },
      ]);
      expect(secondChat.messages).toEqual(secondMessages);
      expect((await resumed.snapshot()).messages).toEqual(secondMessages);
      await secondChat.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("releases the stream lock when opening the chat session fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vyper-chat-open-failure-"));
    const codec = new SessionEventCodec();
    const openLog = () => new FileEventLog<SessionEvent>({ directory, codec });
    const expected = new Error("snapshot failed");

    try {
      const session = await SessionLog.open({
        log: openLog(),
        codec,
        sessionId,
        model: "test-model",
        cwd: "/work",
      });
      session.snapshot = async () => {
        throw expected;
      };

      await expect(
        ChatSession.open({ agent: scriptedAgent([]), session }),
      ).rejects.toBe(expected);

      const retry = await SessionLog.open({
        log: openLog(),
        codec,
        sessionId,
        model: "test-model",
        cwd: "/work",
      });
      await retry.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retracts a turn interrupted by a previous process", async () => {
    const { session } = await openSession();
    await session.append({
      type: SessionEventType.TurnStarted,
      turnId: asTurnId("stale-turn"),
      prompt: "unfinished",
    });
    await session.flush();

    const chat = await ChatSession.open({
      agent: scriptedAgent([]),
      session,
    });
    expect(chat.messages).toEqual([]);

    const snapshot = await session.snapshot();
    expect(snapshot.interruptedTurnId).toBeUndefined();
    const records = await collect(session.read());
    expect(records.at(-1)?.event.type).toBe(SessionEventType.Retraction);
  });

  test("reset appends a durable reset marker", async () => {
    const messages = turnMessages("hello", "one");
    const agent = scriptedAgent([
      {
        events: [modelEvent(1, "one")],
        result: completed(messages, "one"),
      },
    ]);
    const { session } = await openSession();
    const chat = await ChatSession.open({
      agent,
      session,
      createTurnId: () => asTurnId("turn-1"),
    });
    await chat.ask("hello");

    await chat.reset();
    expect(chat.messages).toEqual([]);
    expect((await session.snapshot()).messages).toEqual([]);
    const records = await collect(session.read());
    expect(records.at(-1)?.event.type).toBe(SessionEventType.Reset);
  });

  test("rejects a turn while reset is still being written", async () => {
    const { session } = await openSession();
    const chat = await ChatSession.open({
      agent: scriptedAgent([]),
      session,
    });

    const append = session.append.bind(session);
    let releaseReset = (): void => {};
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let markResetStarted = (): void => {};
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    session.append = async (event) => {
      if (event.type === SessionEventType.Reset) {
        markResetStarted();
        await resetGate;
      }
      return append(event);
    };

    const resetting = chat.reset();
    await resetStarted;
    await expect(chat.ask("blocked")).rejects.toThrow(/reset/i);

    releaseReset();
    await resetting;
    expect(chat.messages).toEqual([]);
    expect((await session.snapshot()).messages).toEqual([]);
  });

  test("resumes with the saved compaction summary in the next request", async () => {
    const { session, storage } = await openSession();
    const turnId = asTurnId("turn-summary");
    const oldMessages = turnMessages("old", "old answer");

    await session.append({
      type: SessionEventType.TurnStarted,
      turnId,
      prompt: "old",
    });
    await session.append({
      type: SessionEventType.ModelResponded,
      turnId,
      step: 1,
      response: { text: "old answer", toolCalls: [] },
    });
    const finished = await session.append({
      type: SessionEventType.TurnFinished,
      turnId,
      status: AgentStatus.Completed,
      output: "old answer",
      steps: 1,
      usage: zeroUsage(),
      messages: oldMessages,
    });
    await session.append({
      type: SessionEventType.Compaction,
      summary: "the old answer",
      cutoffSequence: finished.sequence,
      tokensBefore: 10,
      at: 2_000,
    });
    await session.flush();
    await session.close();

    const reopened = await SessionLog.open({
      log: storage,
      sessionId,
      model: "test-model",
      cwd: "/work",
    });
    expect((await reopened.snapshot()).messages).toEqual([]);

    // The real agent merges adjacent user messages, so the committed history
    // starts with the summary and prompt in one message.
    const nextMessages: Message[] = [
      { role: "user", content: "the old answer\n\ncontinue" },
      { role: "assistant", content: "next" },
    ];
    const agent = scriptedAgent([
      {
        events: [modelEvent(1, "next")],
        result: completed(nextMessages, "next"),
      },
    ]);
    const chat = await ChatSession.open({
      agent,
      session: reopened,
      createTurnId: () => asTurnId("turn-next"),
    });

    await chat.ask("continue");
    expect(agent.runs[0]).toEqual([
      { role: "user", content: "the old answer" },
      { role: "user", content: "continue" },
    ]);
    expect(chat.messages).toEqual(nextMessages);
    await chat.close();

    // The summary is now part of committed history; reopening must not inject
    // it a second time.
    const resumedAgain = await SessionLog.open({
      log: storage,
      sessionId,
      model: "test-model",
      cwd: "/work",
    });
    const secondAgent = scriptedAgent([
      {
        events: [modelEvent(1, "again")],
        result: completed(
          [
            ...nextMessages,
            { role: "user", content: "again" },
            { role: "assistant", content: "again" },
          ],
          "again",
        ),
      },
    ]);
    const secondChat = await ChatSession.open({
      agent: secondAgent,
      session: resumedAgain,
      createTurnId: () => asTurnId("turn-again"),
    });
    await secondChat.ask("again");
    expect(secondAgent.runs[0]).toEqual([
      ...nextMessages,
      { role: "user", content: "again" },
    ]);
    await secondChat.close();
  });

  test("a non-JSON model response retracts the turn without poisoning the log", async () => {
    const badMessages = turnMessages("bad", "never");
    const goodMessages = turnMessages("good", "ok");
    const agent = scriptedAgent([
      {
        events: [
          modelEvent(1, "", [
            {
              id: asToolCallId("call-bad"),
              name: "echo",
              arguments: { value: undefined },
            },
          ]),
        ],
        result: completed(badMessages, "never"),
      },
      {
        events: [modelEvent(1, "ok")],
        result: completed(goodMessages, "ok"),
      },
    ]);
    const { session } = await openSession();
    let turn = 0;
    const chat = await ChatSession.open({
      agent,
      session,
      createTurnId: () => asTurnId(`turn-${++turn}`),
    });

    await expect(chat.ask("bad")).rejects.toThrow(/JSON-safe/);
    expect(chat.messages).toEqual([]);
    expect((await session.snapshot()).messages).toEqual([]);

    const result = await chat.ask("good");
    expect(result.status).toBe(AgentStatus.Completed);
    expect(chat.messages).toEqual(goodMessages);
    expect((await session.snapshot()).messages).toEqual(goodMessages);
  });
});
