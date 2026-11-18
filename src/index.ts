
import { main } from "./cli";

export * from "./types";

export { Agent } from "./agent/agent";
export { InvalidModelResponseError, validateModelResponse } from "./agent/model-response";

export { ToolRegistry } from "./tools/registry";
export { ToolExecutionEngine, executeTool } from "./tools/executor";
export type {
  ExecuteToolOptions,
  ToolExecutionCallbacks,
  ToolExecutionEngineOptions,
  ToolExecutionRequest,
} from "./tools/executor";
export { builtinTools, createToolRegistry, discoverTools } from "./tools/discovery";
export type { ToolDiscoveryOptions } from "./tools/discovery";
export { validateToolDefinition, TOOL_NAME_PATTERN } from "./tools/validation";
export { read } from "./tools/builtin/read";
export { grep } from "./tools/builtin/grep";
export { bash } from "./tools/builtin/bash";

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
