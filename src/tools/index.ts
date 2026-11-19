export { ToolRegistry } from "./registry";
export { ToolExecutionEngine, executeTool } from "./executor";
export type {
  ExecuteToolOptions,
  ToolExecutionCallbacks,
  ToolExecutionEngineOptions,
} from "./executor";
export { builtinTools, createToolRegistry, discoverTools } from "./discovery";
export type { ToolDiscoveryOptions } from "./discovery";
export {
  isJsonSchema,
  validateToolDefinition,
  TOOL_NAME_PATTERN,
} from "./validation";
export { defineTool } from "./define-tool";
export type { DefinedTool, DefineToolOptions } from "./define-tool";
export { read } from "./builtin/read";
export { grep } from "./builtin/grep";
export { bash } from "./builtin/bash";

export { ToolExecutionErrorKind } from "../types/tools";
export type {
  JsonArraySchema,
  JsonBooleanSchema,
  JsonIntegerSchema,
  JsonNullSchema,
  JsonNumberSchema,
  JsonObjectSchema,
  JsonPrimitive,
  JsonSchema,
  JsonSchemaValue,
  JsonStringSchema,
  JsonValue,
  ToolSchema,
  ToolDefinition,
  ToolCatalog,
  ToolContext,
  ToolExecutionInput,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolRunContext,
} from "../types/tools";
