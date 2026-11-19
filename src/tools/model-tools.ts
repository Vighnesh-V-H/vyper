import type { ModelTool } from "../types/model";
import type { ToolDefinition } from "../types/tools";

/** Project a tool definition onto the provider-neutral model contract. */
export function createModelTool(tool: ToolDefinition): ModelTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  };
}

export function createModelTools(tools: Iterable<ToolDefinition>): ModelTool[] {
  return [...tools].map(createModelTool);
}
