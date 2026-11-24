import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { ERROR_MESSAGES } from "../src/errors";
import { clockTool } from "../src/tools/builtin/clock";
import { ToolRegistry } from "../src/tools/registry";
import { AgentErrorStage, AgentEventType, AgentStatus } from "../src/types/agent";
import type { ContextManager, PrepareContextInput, PreparedContext } from "../src/types/context";
import { asToolCallId } from "../src/types/ids";
import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from "../src/types/model";
import { ModelStreamChunkType } from "../src/types/model";

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

/** Return the given streams in order and fail if the run asks for more. */
function sequenceStreamModel(
  streams: readonly (() => AsyncIterable<ModelStreamChunk>)[],
): Model {
  let index = 0;
  return {
    async generate(): Promise<ModelResponse> {
      throw new Error("generate() should not be used when streamText exists");
    },
    streamText(): AsyncIterable<ModelStreamChunk> {
      const stream = streams[index];
      index += 1;
      if (!stream) throw new Error("unexpected model call");
      return stream();
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
          toolCalls: [{ id: asToolCallId("call-1"), name: "clock", arguments: {} }],
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
      onEvent: (event) => {
        events.push(event.type);
      },
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
          toolCalls: [{ id: asToolCallId("call-1"), name: "missing", arguments: {} }],
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

  test("keeps a model response that arrived just before an abort", async () => {
    const controller = new AbortController();
    const agent = new Agent({
      model: sequenceModel([{ text: "partial answer", toolCalls: [] }]),
      instructions: "test",
      tools,
      context,
      cwd,
      onEvent: (event) => {
        if (event.type === AgentEventType.ModelResponse) controller.abort();
      },
    });

    const result = await agent.run("hello", { signal: controller.signal });

    expect(result.status).toBe(AgentStatus.Aborted);
    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" },
    ]);
  });

  test("pairs a response's tool calls with cancelled results on abort", async () => {
    const controller = new AbortController();
    const callId = asToolCallId("call-abort");
    const agent = new Agent({
      model: sequenceModel([
        {
          text: "",
          toolCalls: [{ id: callId, name: "clock", arguments: {} }],
        },
      ]),
      instructions: "test",
      tools,
      context,
      cwd,
      onEvent: (event) => {
        if (event.type === AgentEventType.ModelResponse) controller.abort();
      },
    });

    const result = await agent.run("hello", { signal: controller.signal });

    expect(result.status).toBe(AgentStatus.Aborted);
    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        toolCalls: [{ id: callId, name: "clock", arguments: {} }],
      },
      {
        role: "tool",
        toolCallId: callId,
        content: ERROR_MESSAGES.tools.executionCancelled,
      },
    ]);
  });

  test("keeps streamed text produced before an abort", async () => {
    const controller = new AbortController();
    let firstChunk!: () => void;
    const sawChunk = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const agent = new Agent({
      model: {
        async generate(): Promise<ModelResponse> {
          throw new Error("generate() should not be used when streamText exists");
        },
        async *streamText(
          input: ModelRequest,
        ): AsyncIterable<ModelStreamChunk> {
          yield { type: ModelStreamChunkType.TextDelta, text: "partial " };
          firstChunk();
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) {
              resolve();
              return;
            }
            input.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        },
      },
      instructions: "test",
      tools,
      context,
      cwd,
    });

    const pending = agent.run("hello", { signal: controller.signal });
    await sawChunk;
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(AgentStatus.Aborted);
    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial " },
    ]);
  });

  test("completes normally through a model stream", async () => {
    const agent = new Agent({
      model: {
        async generate(): Promise<ModelResponse> {
          throw new Error("generate() should not be used when streamText exists");
        },
        async *streamText(): AsyncIterable<ModelStreamChunk> {
          yield { type: ModelStreamChunkType.TextDelta, text: "streamed " };
          yield { type: ModelStreamChunkType.TextDelta, text: "answer" };
          yield {
            type: ModelStreamChunkType.Usage,
            usage: { inputTokens: 2, outputTokens: 3 },
          };
          yield { type: ModelStreamChunkType.Done };
        },
      },
      instructions: "test",
      tools,
      context,
      cwd,
    });

    const result = await agent.run("hello");

    expect(result.status).toBe(AgentStatus.Completed);
    expect(result.output).toBe("streamed answer");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  test("executes a tool call assembled from stream deltas", async () => {
    const callId = asToolCallId("call-stream");
    const agent = new Agent({
      model: sequenceStreamModel([
        async function* (): AsyncIterable<ModelStreamChunk> {
          yield { type: ModelStreamChunkType.TextDelta, text: "checking " };
          yield {
            type: ModelStreamChunkType.ToolCallDelta,
            toolCallId: callId,
            name: "clock",
          };
          yield {
            type: ModelStreamChunkType.ToolCallDelta,
            toolCallId: callId,
            argumentsDelta: "{}",
          };
          yield {
            type: ModelStreamChunkType.ToolCallDone,
            toolCall: { id: callId, name: "clock", arguments: {} },
          };
          yield { type: ModelStreamChunkType.Done };
        },
        async function* (): AsyncIterable<ModelStreamChunk> {
          yield { type: ModelStreamChunkType.TextDelta, text: "final answer" };
          yield { type: ModelStreamChunkType.Done };
        },
      ]),
      instructions: "test",
      tools,
      context,
      cwd,
    });

    const result = await agent.run("hello");

    expect(result.status).toBe(AgentStatus.Completed);
    expect(result.output).toBe("final answer");
    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "checking ",
        toolCalls: [{ id: callId, name: "clock", arguments: {} }],
      },
      expect.objectContaining({ role: "tool", toolCallId: callId }),
      { role: "assistant", content: "final answer" },
    ]);
  });

  test("keeps completed and cancelled tool results when aborting mid-batch", async () => {
    const controller = new AbortController();
    const firstCall = asToolCallId("call-first");
    const secondCall = asToolCallId("call-second");
    const agent = new Agent({
      model: sequenceModel([
        {
          text: "",
          toolCalls: [
            { id: firstCall, name: "clock", arguments: {} },
            { id: secondCall, name: "clock", arguments: {} },
          ],
        },
      ]),
      instructions: "test",
      tools,
      context,
      cwd,
      onEvent: (event) => {
        if (event.type === AgentEventType.ToolResult) controller.abort();
      },
    });

    const result = await agent.run("hello", { signal: controller.signal });

    expect(result.status).toBe(AgentStatus.Aborted);
    const toolMessages = result.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).not.toBe(
      ERROR_MESSAGES.tools.executionCancelled,
    );
    expect(toolMessages[1]?.content).toBe(
      ERROR_MESSAGES.tools.executionCancelled,
    );
  });

  test("stops at the iteration limit", async () => {
    const agent = new Agent({
      model: sequenceModel([
        {
          text: "",
          toolCalls: [{ id: asToolCallId("call-1"), name: "clock", arguments: {} }],
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
