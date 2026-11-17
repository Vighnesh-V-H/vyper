import type { Model } from "./model";
import type { ToolDefinition } from "./tools";
import type { ContextManager } from "./context";

export interface AgentOptions {
  model: Model;
  instructions: string;
  tools: ToolDefinition[];
  context: ContextManager;
  maxSteps?: number;
  cwd: string;
}
