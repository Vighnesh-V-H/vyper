import { describe, expect, test } from "bun:test";
import { ChatSession } from "../src/cli-session";
import type { ChatAgent } from "../src/cli-session";
import type { AgentResult, AgentRunOptions } from "../src/types/agent";
import { AgentErrorStage, AgentStatus } from "../src/types/agent";
import type { Message } from "../src/types/message";

interface RecordedRun {
  readonly input: string | readonly Message[];
  readonly options: AgentRunOptions | undefined;
}

interface RecordingAgent extends ChatAgent {
  readonly runs: RecordedRun[];
}

function recordingAgent(responses: readonly AgentResult[]): RecordingAgent {
  const runs: RecordedRun[] = [];
  let index = 0;
  return {
    runs,
    async run(input, options) {
      runs.push({ input, options });
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("unexpected agent run");
      return response;
    },
  };
}

function completed(messages: readonly Message[], output: string): AgentResult {
  return {
    status: AgentStatus.Completed,
    messages,
    output,
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function failed(messages: readonly Message[]): AgentResult {
  return {
    status: AgentStatus.Error,
    stage: AgentErrorStage.Model,
    error: new Error("model failed"),
    messages,
    output: "model failed",
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function aborted(): AgentResult {
  return {
    status: AgentStatus.Aborted,
    messages: [],
    output: "aborted",
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("ChatSession", () => {
  test("keeps asking after a turn and passes history to the next run", async () => {
    const firstTurn: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ];
    const secondTurn: Message[] = [
      ...firstTurn,
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ];
    const agent = recordingAgent([
      completed(firstTurn, "one"),
      completed(secondTurn, "two"),
    ]);
    const session = new ChatSession(agent);

    expect((await session.ask("first")).output).toBe("one");
    expect((await session.ask("second")).output).toBe("two");

    expect(agent.runs[0]?.input).toBe("first");
    expect(agent.runs[1]?.input).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
    ]);
    expect(session.messages).toEqual(secondTurn);
  });

  test("rolls back a failed turn so the next prompt is clean", async () => {
    const firstTurn: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ];
    const failedTurn: Message[] = [
      ...firstTurn,
      { role: "user", content: "second" },
    ];
    const thirdTurn: Message[] = [
      ...firstTurn,
      { role: "user", content: "third" },
      { role: "assistant", content: "three" },
    ];
    const agent = recordingAgent([
      completed(firstTurn, "one"),
      failed(failedTurn),
      completed(thirdTurn, "three"),
    ]);
    const session = new ChatSession(agent);

    await session.ask("first");
    const failure = await session.ask("second");
    expect(failure.status).toBe(AgentStatus.Error);
    expect(session.messages).toEqual(firstTurn);

    await session.ask("third");
    expect(agent.runs[2]?.input).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "third" },
    ]);
  });

  test("abort stops the in-flight turn and discards its history", async () => {
    let receivedSignal: AbortSignal | undefined;
    const agent: ChatAgent = {
      run(_input, options) {
        receivedSignal = options?.signal;
        return new Promise<AgentResult>((resolve) => {
          const signal = options?.signal;
          if (signal === undefined) {
            resolve(aborted());
            return;
          }
          if (signal.aborted) {
            resolve(aborted());
            return;
          }
          signal.addEventListener("abort", () => resolve(aborted()), {
            once: true,
          });
        });
      },
    };
    const session = new ChatSession(agent);

    const pending = session.ask("slow");
    expect(session.isRunning).toBe(true);
    session.abort();

    const result = await pending;
    expect(result.status).toBe(AgentStatus.Aborted);
    expect(receivedSignal?.aborted).toBe(true);
    expect(session.isRunning).toBe(false);
    expect(session.messages).toEqual([]);
  });

  test("a throwing agent leaves the session usable and reset clears history", async () => {
    let shouldThrow = true;
    const agent: ChatAgent = {
      async run(input) {
        if (shouldThrow) throw new Error("transport exploded");
        const messages: Message[] = [
          { role: "user", content: String(input) },
          { role: "assistant", content: "ok" },
        ];
        return completed(messages, "ok");
      },
    };
    const session = new ChatSession(agent);

    await expect(session.ask("first")).rejects.toThrow("transport exploded");
    expect(session.isRunning).toBe(false);
    expect(session.messages).toEqual([]);

    shouldThrow = false;
    await session.ask("second");
    expect(session.messages).toHaveLength(2);

    await session.reset();
    expect(session.messages).toEqual([]);
  });
});
