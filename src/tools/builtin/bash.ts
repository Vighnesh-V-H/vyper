import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { JsonSchema, ToolDefinition } from "../../types/tools";

interface BashArgs { command: string }
const parameters: JsonSchema = {
  type: "object",
  properties: { command: { type: "string", description: "Shell command to execute" } },
  required: ["command"],
  additionalProperties: false,
};
const run = promisify(exec);
const SAFE_COMMANDS = new Set(["ls", "pwd", "which", "find", "head", "tail", "wc", "git"]);
function parse(input: unknown): BashArgs {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be an object");
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string");
  return { command: command.trim() };
}
function isSafe(command: string): boolean {
  if (/[;&|`$<>\n\r]/.test(command) || /\$\(|\\/.test(command)) return false;
  const [program, subcommand] = command.split(/\s+/, 2);
  if (!program || !SAFE_COMMANDS.has(program)) return false;
  return program !== "git" || ["status", "diff", "log", "show"].includes(subcommand ?? "");
}

export const bash: ToolDefinition<BashArgs, string> = {
  name: "bash",
  description: "Run a shell command in the working directory. Only a limited set of read-only commands run automatically; other commands are denied.",
  parameters,
  parse,
  async execute({ command }, { cwd, signal }) {
    if (!isSafe(command)) throw new Error("Command requires approval or is not in the automatic allowlist");
    if (signal.aborted) throw new Error("Tool execution cancelled");
    try {
      const { stdout, stderr } = await run(command, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, signal });
      return `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.trimEnd() || "(no output)";
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      if (signal.aborted) throw new Error("Tool execution cancelled");
      const output = [failure.stdout, failure.stderr].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
      throw new Error(`Command failed${failure.code === undefined ? "" : ` (exit ${failure.code})`}${output ? `:\n${output}` : `: ${failure.message}`}`);
    }
  },
  render: (_args, result) => result,
};
