import type { ToolCatalog } from "../../src/types/tools";

export type ToolKind = "builtin" | "app";

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
}

/** Everything the TUI needs, loaded once at startup. */
export interface TuiConfig {
  readonly cwd: string;
  readonly branch: string;
  readonly model: string;
  /** Undefined when the user has not configured a provider key. */
  readonly apiKey: string | undefined;
  readonly instructions: string;
  readonly maxSteps: number;
  readonly toolConcurrency: number;
  readonly sessionDirectory: string;
  readonly tools: ToolCatalog;
  readonly toolSummaries: readonly ToolSummary[];
  readonly runtime: string;
}
