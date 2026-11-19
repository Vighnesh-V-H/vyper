import { ERROR_MESSAGES, ToolRegistrationError } from "../errors";
import type { ModelTool } from "../types/model";
import type { ToolCatalog, ToolDefinition } from "../types/tools";
import { createModelTools } from "./model-tools";
import { validateToolDefinition } from "./validation";

/**
 * An insertion-ordered catalog of named tools.
 *
 * Registration is validated and atomic: if any candidate is invalid or a name
 * collides, the registry is left unchanged. Lookups are exact and
 * case-sensitive; unknown names are reported by the execution engine rather
 * than throwing here.
 */
export class ToolRegistry implements ToolCatalog {
  readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: Iterable<ToolDefinition> = []) {
    this.registerMany(tools);
  }

  register(tool: ToolDefinition): this {
    return this.registerMany([tool]);
  }

  registerMany(tools: Iterable<ToolDefinition>): this {
    const pending = [...tools];
    const names = new Set<string>();

    for (const tool of pending) {
      validateToolDefinition(tool);
      if (this.tools.has(tool.name) || names.has(tool.name)) {
        throw new ToolRegistrationError(
          ERROR_MESSAGES.toolRegistry.alreadyRegistered(tool.name),
        );
      }
      names.add(tool.name);
    }

    for (const tool of pending) this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /** A snapshot in registration order. Mutating the array cannot alter the registry. */
  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Provider-neutral tool descriptions. Each call returns fresh objects. */
  toModelTools(): ModelTool[] {
    return createModelTools(this.tools.values());
  }
}
