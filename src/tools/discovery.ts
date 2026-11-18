import type { ToolDefinition } from "../types/tools";
import { bash } from "./builtin/bash";
import { grep } from "./builtin/grep";
import { read } from "./builtin/read";
import { ToolRegistry } from "./registry";

/**
 * First-party tools. Applications may use these directly, compose them with
 * their own tools, or omit them entirely.
 */
export const builtinTools: readonly ToolDefinition[] = Object.freeze([read, grep, bash]);

export interface ToolDiscoveryOptions {
  /** Include the first-party read/grep/bash tools. Defaults to true. */
  readonly builtins?: boolean;
  /** Application or plugin tools, considered after built-ins. */
  readonly tools?: Iterable<ToolDefinition>;
  /** Optional predicate applied after composition (for example, feature flags). */
  readonly include?: (tool: ToolDefinition) => boolean;
}

/**
 * Resolve the explicit set of tools for a registry.
 *
 * Discovery is deliberately composition-only: it does not scan the filesystem
 * or import modules by path. Loading tools is an application policy and should
 * stay outside the generic harness.
 */
export function discoverTools(options: ToolDiscoveryOptions = {}): readonly ToolDefinition[] {
  if (!options || typeof options !== "object") throw new TypeError("ToolDiscoveryOptions must be an object");
  const tools: ToolDefinition[] = [];
  if (options.builtins !== false) tools.push(...builtinTools);
  if (options.tools) tools.push(...options.tools);
  return options.include ? tools.filter(options.include) : tools;
}

/** Compose tools and build a validated registry in one step. */
export function createToolRegistry(options: ToolDiscoveryOptions = {}): ToolRegistry {
  return new ToolRegistry(discoverTools(options));
}
