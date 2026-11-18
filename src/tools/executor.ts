import type { ToolContext, ToolExecutionResult } from "../types/tools";
import { ToolRegistry } from "./registry";

export interface ExecuteToolOptions extends ToolContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly rootCallId?: string;
}

export async function executeTool(
  registry: ToolRegistry,
  options: ExecuteToolOptions,
): Promise<ToolExecutionResult> {
  const tool = registry.get(options.name);
  if (!tool) {
    return { callId: options.callId, name: options.name, content: `Unknown tool: ${options.name}`, isError: true };
  }
  if (options.signal.aborted) {
    return { callId: options.callId, name: options.name, content: "Tool execution cancelled", isError: true };
  }

  try {
    const args = tool.parse(options.arguments);
    const result = await tool.execute(args, {
      cwd: options.cwd,
      signal: options.signal,
      deferContext: options.deferContext,
      concludeTurn: options.concludeTurn,
    });
    return { callId: options.callId, name: options.name, content: tool.render(args, result), isError: false };
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error);
    return { callId: options.callId, name: options.name, content, isError: true };
  }
}
