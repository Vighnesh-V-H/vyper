
import { main } from "./cli";
import { errorMessage } from "./errors";

export * from "./errors";
export * from "./types";

export { Agent } from "./agent/agent";
export { validateModelResponse } from "./agent/model-response";

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
export {
  isJsonSchema,
  validateToolDefinition,
  TOOL_NAME_PATTERN,
} from "./tools/validation";
export { defineTool } from "./tools/define-tool";
export type { DefinedTool, DefineToolOptions } from "./tools/define-tool";
export { read } from "./tools/builtin/read";
export { grep } from "./tools/builtin/grep";
export { bash } from "./tools/builtin/bash";

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
