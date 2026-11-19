import type { TokenUsage } from "./context";
import type { JsonObjectSchema } from "./json-schema";
import type { Message, ToolCall } from "./message";

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}

export interface ModelRequest {
  messages: Message[];
  tools: ModelTool[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

/** Kinds of incremental output a provider may stream. */
export enum ModelStreamChunkType {
  TextDelta = "text-delta",
  ToolCallDelta = "tool-call-delta",
  ToolCallDone = "tool-call-done",
  Usage = "usage",
  Done = "done",
}

export interface TextDeltaChunk {
  type: ModelStreamChunkType.TextDelta;
  text: string;
}

export interface ToolCallDeltaChunk {
  type: ModelStreamChunkType.ToolCallDelta;
  toolCallId: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ToolCallDoneChunk {
  type: ModelStreamChunkType.ToolCallDone;
  toolCall: ToolCall;
}

export interface UsageChunk {
  type: ModelStreamChunkType.Usage;
  usage: TokenUsage;
}

export interface DoneChunk {
  type: ModelStreamChunkType.Done;
}

export type ModelStreamChunk =
  | TextDeltaChunk
  | ToolCallDeltaChunk
  | ToolCallDoneChunk
  | UsageChunk
  | DoneChunk;

export interface Model {
  /**
   * Provider adapters own retries, backoff, and transport error normalization.
   * The agent loop fails fast on model errors.
   */
  generate(input: ModelRequest): Promise<ModelResponse>;

  streamText?(input: ModelRequest): AsyncIterable<ModelStreamChunk>;
}
