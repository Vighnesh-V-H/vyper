import type { ToolCallId } from "./ids";

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: ToolCallId;
  content: string;
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ToolCall {
  id: ToolCallId;
  name: string;
  /** Agent-side arguments stay untrusted until a tool parser or codec reads them. */
  arguments: Record<string, unknown>;
}
