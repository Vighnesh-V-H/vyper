import type { ModelTool } from "../types/model";
import type { ToolDefinition } from "../types/tools";

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  constructor(tools: Iterable<ToolDefinition> = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: ToolDefinition): this {
    if (!tool.name.trim()) throw new Error("Tool name must not be empty");
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }

  toModelTools(): ModelTool[] {
    return [...this.#tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      inputSchema: parameters,
    }));
  }
}
