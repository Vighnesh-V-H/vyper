import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  ERROR_MESSAGES,
  ToolCancelledError,
  ToolExecutionError,
  ToolInputError,
} from "../../errors";
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
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError(ERROR_MESSAGES.tools.argumentsMustBeObject);
  }
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim()) {
    throw new ToolInputError(ERROR_MESSAGES.tools.commandMustBeNonEmptyString);
  }
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
  description: `Run a shell command in the working directory. Commands outside the automatic allowlist are denied; this tool does not request approval.\nWHEN TO USE: Running simple read-only inspection commands such as ls, pwd, find, head, tail, wc, which, or git status/diff/log/show.\nWHEN NOT TO USE: Reading a file (use read); searching file contents (use grep); writing files, installing packages, changing system state, or executing commands that need approval.\nARGUMENTS:\n- command (string, required): One simple command invocation. Shell chaining, pipes, redirection, substitutions, and newlines are blocked.\nThe automatic allowlist is intentionally restrictive; denied commands return an error rather than being executed.`, 
  parameters,
  parse,
  async execute({ command }, { cwd, signal }) {
    if (!isSafe(command)) {
      throw new ToolExecutionError(ERROR_MESSAGES.tools.commandRequiresApproval);
    }
    if (signal.aborted) throw new ToolCancelledError();
    try {
      const { stdout, stderr } = await run(command, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, signal });
      return `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.trimEnd() || "(no output)";
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      if (signal.aborted) throw new ToolCancelledError();
      const output = [failure.stdout, failure.stderr].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
      throw new ToolExecutionError(
        ERROR_MESSAGES.tools.commandFailed(
          failure.code,
          output,
          failure.message,
        ),
        { cause: failure },
      );
    }
  },
  render: (_args, result) => result,
};
