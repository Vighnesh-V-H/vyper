export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };


export interface UserMessage {
  role: "user";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
