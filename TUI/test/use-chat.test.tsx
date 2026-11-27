import { describe, expect, test } from "bun:test";
import { createRef, forwardRef, useImperativeHandle } from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ChatSession } from "../../src/session/chat";
import { AgentStatus } from "../../src/types/agent";
import type { AgentResult } from "../../src/types/agent";
import type { ChatAgent } from "../../src/types/session";
import type { ToolCatalog } from "../../src/types/tools";
import type { ChatController, ChatOpener } from "../src/chat/use-chat";
import { useChat } from "../src/chat/use-chat";
import type { TuiConfig } from "../src/types";

const tools: ToolCatalog = {
  get: () => undefined,
  list: () => [],
};

function testConfig(): TuiConfig {
  return {
    cwd: process.cwd(),
    model: "test-model",
    apiKey: "test-key",
    instructions: "test instructions",
    maxSteps: 4,
    toolConcurrency: 1,
    sessionDirectory: "/tmp/vyper-sessions",
    tools,
    toolSummaries: [],
    runtime: "Bun test",
  };
}

function completed(output: string): AgentResult {
  return {
    status: AgentStatus.Completed,
    messages: [],
    output,
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

interface ProbeProps {
  readonly config: TuiConfig;
  readonly openChat: ChatOpener;
}

const Probe = forwardRef<ChatController, ProbeProps>(function Probe(props, ref) {
  const chat = useChat(props.config, props.openChat);
  useImperativeHandle(ref, () => chat, [chat]);
  return <text>{chat.state.phase}</text>;
});

describe("useChat", () => {
  test("an abort while opening prevents the first turn from starting", async () => {
    let runCalls = 0;
    const agent: ChatAgent = {
      async run() {
        runCalls += 1;
        return completed("should not run");
      },
    };

    let release:
      | ((result: { chat: ChatSession; sessionId: string }) => void)
      | undefined;
    const openChat: ChatOpener = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const ref = createRef<ChatController>();
    const setup = await testRender(
      <Probe ref={ref} config={testConfig()} openChat={openChat} />,
      { width: 60, height: 8 },
    );

    try {
      let sending: Promise<void> | undefined;
      await act(async () => {
        sending = ref.current?.send("read the agent");
        await Promise.resolve();
      });
      await setup.renderOnce();

      await act(() => {
        ref.current?.abort();
      });

      await act(async () => {
        release?.({ chat: new ChatSession(agent), sessionId: "session-1" });
        await sending;
      });
      await setup.renderOnce();

      expect(runCalls).toBe(0);
      expect(ref.current?.state.phase).toBe("aborted");
      expect(ref.current?.state.items.at(-1)).toMatchObject({
        kind: "notice",
        tone: "warning",
        text: "cancelled before the turn started",
      });
    } finally {
      setup.renderer.destroy();
    }
  });
});
