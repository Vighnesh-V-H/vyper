import type { ToolCall } from "./message";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category?: string;
  tags?: string[];

  execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown>;
}
