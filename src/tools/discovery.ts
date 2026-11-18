import type { ToolDefinition } from "../types/tools";
import { bash } from "./builtin/bash";
import { grep } from "./builtin/grep";
import { read } from "./builtin/read";
import { ToolRegistry } from "./registry";

/** Explicit built-ins; applications may compose these with their own tools. */
export const builtinTools: readonly ToolDefinition[] = [read, grep, bash];

export function createToolRegistry(tools: Iterable<ToolDefinition> = builtinTools): ToolRegistry {
  return new ToolRegistry(tools);
}
