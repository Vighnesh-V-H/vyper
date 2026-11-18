import type { Message, ToolCall } from "./message";
import type { JsonSchema } from "./tools";

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export type ModelStreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: "tool-call-done"; toolCall: ToolCall }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "done" };

export interface Model {
  generate(input: {
    messages: Message[];
    tools: ModelTool[];
    signal?: AbortSignal;
  }): Promise<ModelResponse>;

  streamText?(input: {
    messages: Message[];
    tools: ModelTool[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelStreamChunk>;
}
