import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { ERROR_MESSAGES } from "../src/errors";
import { clockTool } from "../src/tools/builtin/clock";
import { ToolRegistry } from "../src/tools/registry";
import { AgentErrorStage, AgentEventType, AgentStatus } from "../src/types/agent";
import type { ContextManager, PrepareContextInput, PreparedContext } from "../src/types/context";
import type { Model, ModelResponse } from "../src/types/model";

const cwd = process.cwd();
const tools = new ToolRegistry([clockTool]);

const context: ContextManager = {
  async prepare({ messages }: PrepareContextInput): Promise<PreparedContext> {
    return {
      messages: [...messages],
      compacted: false,
      tokensEstimated: 12,
    };
  },
  observe() {},
};

/** Return the given responses in order and fail if the run asks for more. */
function sequenceModel(responses: readonly ModelResponse[]): Model {
  let index = 0;
  return {
    async generate(): Promise<ModelResponse> {
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("unexpected model call");
      return response;
    },
  };
}

describe("Agent", () => {
  test("completes a tool-call round trip", async () => {
    const events: AgentEventType[] = [];
    const agent = new Agent({
      model: sequenceModel([
        {
          text: "",
          toolCalls: [{ id: "call-1", name: "clock", arguments: {} }],
        },
        {
          text: "final answer",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      ]),
      instructions: "test",
      tools,
      context,
      cwd,
      onEvent: (event) => events.push(event.type),
    });

    const result = await agent.run("hello");

    expect(result.status).toBe(AgentStatus.Completed);
    expect(result.output).toBe("final answer");
    expect(result.steps).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(events).toEqual([
      AgentEventType.StepStart,
      AgentEventType.ContextPrepared,
      AgentEventType.ModelResponse,
      AgentEventType.ToolStart,
      AgentEventType.ToolResult,
      AgentEventType.StepStart,
      AgentEventType.ContextPrepared,
      AgentEventType.ModelResponse,
      AgentEventType.Stop,
    ]);
  });

  test("feeds tool failures back to the model", async () => {
    const agent = new Agent({
      model: sequenceModel([
        {
          text: "",
          toolCalls: [{ id: "call-1", name: "missing", arguments: {} }],
        },
        { text: "recovered", toolCalls: [] },
      ]),
      instructions: "test",
      tools,
      context,
      cwd,
    });

    const result = await agent.run("hello");
    const toolMessage = result.messages.find((message) => message.role === "tool");

    expect(result.status).toBe(AgentStatus.Completed);
    expect(result.output).toBe("recovered");
    expect(toolMessage?.content).toContain("Unknown tool: missing");
  });

  test("rejects a malformed model response", async () => {
    const agent = new Agent({
      model: sequenceModel([{ text: "", toolCalls: [] }]),
      instructions: "test",
      tools,
      context,
      cwd,
    });

    const result = await agent.run("hello");

    expect(result.status).toBe(AgentStatus.Error);
    if (result.status === AgentStatus.Error) {
      expect(result.stage).toBe(AgentErrorStage.Response);
      expect(result.error.message).toContain("text or tool calls");
    }
  });

  test("reports an aborted run without calling the model", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = new Agent({
      model: sequenceModel([]),
      instructions: "test",
      tools,
      context,
      cwd,
    });

    const result = await agent.run("hello", { signal: controller.signal });

    expect(result.status).toBe(AgentStatus.Aborted);
    expect(result.output).toBe(ERROR_MESSAGES.agent.runAborted);
  });

  test("stops at the iteration limit", async () => {
    const agent = new Agent({
      model: sequenceModel([
        {
          text: "",
          toolCalls: [{ id: "call-1", name: "clock", arguments: {} }],
        },
      ]),
      instructions: "test",
      tools,
      context,
      cwd,
      maxSteps: 1,
    });

    const result = await agent.run("hello");

    expect(result.status).toBe(AgentStatus.MaxSteps);
    expect(result.steps).toBe(1);
    expect(result.output).toBe(ERROR_MESSAGES.agent.maxStepsReached(1));
  });
});
