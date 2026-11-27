import { describe, expect, test } from "bun:test";
import {
  AgentErrorStage,
  AgentEventType,
  AgentStatus,
} from "../../src/types/agent";
import type { AgentEvent, AgentResult } from "../../src/types/agent";
import { asToolCallId } from "../../src/types/ids";
import {
  chatReducer,
  createInitialChatState,
  describePhase,
} from "../src/chat/state";

const CALL_ID = asToolCallId("call-1");

function apply(
  state = createInitialChatState(),
  ...events: AgentEvent[]
): ReturnType<typeof chatReducer> {
  return events.reduce(
    (current, event) => chatReducer(current, { type: "agent-event", event }),
    state,
  );
}

function completed(output: string, steps = 1): AgentResult {
  return {
    status: AgentStatus.Completed,
    messages: [],
    output,
    steps,
    usage: { inputTokens: 1_200, outputTokens: 300 },
  };
}

describe("chatReducer", () => {
  test("maps a tool round trip and keeps exactly one final answer", () => {
    let state = chatReducer(createInitialChatState(), {
      type: "prompt",
      text: "inspect the agent",
    });

    state = apply(
      state,
      { type: AgentEventType.StepStart, step: 1 },
      {
        type: AgentEventType.ToolStart,
        step: 1,
        callId: CALL_ID,
        name: "read",
      },
      {
        type: AgentEventType.ToolResult,
        step: 1,
        result: {
          callId: CALL_ID,
          name: "read",
          content: "agent source",
          isError: false,
          durationMs: 42,
        },
      },
      {
        type: AgentEventType.ModelResponse,
        step: 1,
        response: { text: "Done.", toolCalls: [] },
      },
    );

    expect(state.phase).toBe("running");
    expect(state.activeTool).toBeUndefined();

    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      name: "read",
      status: "ok",
      durationMs: 42,
    });

    state = chatReducer(state, {
      type: "finished",
      result: completed("Done."),
    });

    expect(state.phase).toBe("ready");
    expect(state.items.filter((item) => item.kind === "assistant")).toHaveLength(
      1,
    );
    expect(state.items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "success",
      text: "done · 1 step · 1.2k in · 300 out",
    });
  });

  test("sanitizes failed tool output and deduplicates the error notice", () => {
    let state = chatReducer(createInitialChatState(), {
      type: "prompt",
      text: "delete the build",
    });

    state = apply(
      state,
      {
        type: AgentEventType.ToolStart,
        step: 1,
        callId: CALL_ID,
        name: "bash",
      },
      {
        type: AgentEventType.ToolResult,
        step: 1,
        result: {
          callId: CALL_ID,
          name: "bash",
          content: "\u001b[31mdenied\u001b[0m\r\npath outside root",
          isError: true,
          durationMs: 8,
        },
      },
      {
        type: AgentEventType.Error,
        step: 1,
        stage: AgentErrorStage.Tools,
        error: new Error("permission denied"),
      },
    );

    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      status: "error",
      detail: "denied path outside root",
    });

    state = chatReducer(state, {
      type: "finished",
      result: {
        status: AgentStatus.Error,
        stage: AgentErrorStage.Tools,
        error: new Error("permission denied"),
        messages: [],
        output: "permission denied",
        steps: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });

    const errors = state.items.filter(
      (item) => item.kind === "notice" && item.tone === "danger",
    );
    expect(errors).toHaveLength(1);
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("tools: permission denied");
  });

  test("keeps partial assistant text and marks an aborted turn", () => {
    let state = chatReducer(createInitialChatState(), {
      type: "prompt",
      text: "slow task",
    });
    state = apply(
      state,
      {
        type: AgentEventType.ModelResponse,
        step: 2,
        partial: true,
        response: { text: "partial answer", toolCalls: [] },
      },
      {
        type: AgentEventType.Stop,
        status: AgentStatus.Aborted,
        steps: 2,
      },
    );
    state = chatReducer(state, {
      type: "finished",
      result: {
        status: AgentStatus.Aborted,
        messages: [],
        output: "Run aborted.",
        steps: 2,
        usage: { inputTokens: 15, outputTokens: 7 },
      },
    });

    expect(state.phase).toBe("aborted");
    expect(state.items.find((item) => item.kind === "assistant")).toMatchObject({
      text: "partial answer",
      partial: true,
    });
    const last = state.items.at(-1);
    expect(last).toMatchObject({
      kind: "notice",
      tone: "warning",
    });
    expect(last?.kind === "notice" ? last.text : "").toContain(
      "partial history saved",
    );
  });

  test("leaves the running phase when an opening is cancelled", () => {
    const prompted = chatReducer(createInitialChatState(), {
      type: "prompt",
      text: "slow session open",
    });

    expect(prompted.phase).toBe("running");

    const cancelled = chatReducer(prompted, { type: "cancelled" });
    expect(cancelled.phase).toBe("aborted");
    expect(cancelled.items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "warning",
      text: "cancelled before the turn started",
    });
  });

  test("reset returns a clean idle state", () => {
    const state = chatReducer(
      {
        ...createInitialChatState(),
        sessionId: "session-1",
        phase: "ready",
      },
      { type: "reset" },
    );

    expect(state).toEqual(createInitialChatState());
  });
});

describe("describePhase", () => {
  test("reports the active tool while running", () => {
    const state = {
      ...createInitialChatState(),
      phase: "running" as const,
      step: 3,
      activeTool: "grep",
    };
    expect(describePhase(state)).toEqual({
      label: "tool grep",
      tone: "warning",
    });
  });

  test("reports waiting after a step without a tool", () => {
    const state = {
      ...createInitialChatState(),
      phase: "running" as const,
      step: 2,
    };
    expect(describePhase(state)).toEqual({
      label: "step 2 · waiting",
      tone: "accent",
    });
  });
});
