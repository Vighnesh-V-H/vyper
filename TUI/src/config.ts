import { createToolRegistry, builtinTools } from "../../src/tools/discovery";
import { clockTool } from "../../src/tools/builtin/clock";
import { resolveSessionDirectory } from "../../src/cli";
import type { ToolDefinition } from "../../src/types/tools";
import { preview } from "./format";
import type { ToolSummary, TuiConfig } from "./types";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_STEPS = 12;
const API_KEY_VARIABLE = "GOOGLE_GENERATIVE_AI_API_KEY";

const BUILTIN_NAMES = new Set(builtinTools.map((tool) => tool.name));

export const INSTRUCTIONS = [
  "You are a coding assistant working inside the user's repository.",
  "Use the provided tools to inspect files before answering.",
  "Keep answers concise and reference concrete file paths.",
  "Do not run destructive shell commands.",
].join("\n");

function summarize(tool: ToolDefinition): ToolSummary {
  return {
    name: tool.name,
    description: preview(tool.description, 280),
    kind: BUILTIN_NAMES.has(tool.name) ? "builtin" : "app",
  };
}

/**
 * Composition root for the TUI. Provider keys stay optional so the interface
 * can still document and inspect the harness without network access.
 */
export function loadTuiConfig(): TuiConfig {
  const registry = createToolRegistry({ tools: [clockTool] });
  const apiKey = process.env[API_KEY_VARIABLE]?.trim();
  const configuredModel = process.env.GEMINI_MODEL?.trim();

  return {
    cwd: process.cwd(),
    model:
      configuredModel === undefined || configuredModel.length === 0
        ? DEFAULT_MODEL
        : configuredModel,
    apiKey: apiKey === undefined || apiKey.length === 0 ? undefined : apiKey,
    instructions: INSTRUCTIONS,
    maxSteps: MAX_STEPS,
    toolConcurrency: 1,
    sessionDirectory: resolveSessionDirectory(
      process.cwd(),
      process.env.VYPER_SESSION_DIR,
    ),
    tools: registry,
    toolSummaries: registry.list().map(summarize),
    runtime: `Bun ${Bun.version}`,
  };
}
