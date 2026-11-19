import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  ERROR_MESSAGES,
  ToolCancelledError,
  ToolExecutionError,
  errorMessage,
} from "../../errors";
import type { JsonObjectSchema, JsonSchemaValue } from "../../types/json-schema";
import { isNonEmptyString } from "../../util/is-non-empty-string";
import { isRecord } from "../../util/is-record";
import { omitUndefined } from "../../util/omit-undefined";
import { readArguments, requiredNonBlankString } from "../arguments";
import { defineTool } from "../define-tool";

const parameters = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
  },
  required: ["command"],
  additionalProperties: false,
} as const satisfies JsonObjectSchema;

type BashArgs = JsonSchemaValue<typeof parameters>;

interface ExecFailure {
  readonly message: string;
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

const run = promisify(exec);
const SAFE_COMMANDS = new Set([
  "ls",
  "pwd",
  "which",
  "find",
  "head",
  "tail",
  "wc",
  "git",
]);

function parse(input: unknown): BashArgs {
  const value = readArguments(input);
  return {
    command: requiredNonBlankString(
      value,
      "command",
      ERROR_MESSAGES.tools.commandMustBeNonEmptyString,
    ).trim(),
  };
}

function isSafe(command: string): boolean {
  if (/[;&|`$<>\n\r]/.test(command) || /\$\(|\\/.test(command)) return false;
  const [program, subcommand] = command.split(/\s+/, 2);
  if (!program || !SAFE_COMMANDS.has(program)) return false;
  return (
    program !== "git" ||
    ["status", "diff", "log", "show"].includes(subcommand ?? "")
  );
}

/** Read the fields Node's child_process errors expose, without trusting them. */
function readExecFailure(error: unknown): ExecFailure {
  if (!isRecord(error)) return { message: errorMessage(error) };

  const { code, stdout, stderr } = error;
  return omitUndefined({
    message: errorMessage(error),
    code:
      typeof code === "number" || typeof code === "string" ? code : undefined,
    stdout: isNonEmptyString(stdout) ? stdout : undefined,
    stderr: isNonEmptyString(stderr) ? stderr : undefined,
  });
}

export const bash = defineTool({
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
      const { stdout, stderr } = await run(command, {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      const output = [stdout, stderr]
        .filter((part) => part.length > 0)
        .join("\n");
      return output.trimEnd() || "(no output)";
    } catch (error) {
      const failure = readExecFailure(error);
      if (signal.aborted) throw new ToolCancelledError();
      const output = [failure.stdout, failure.stderr]
        .filter(isNonEmptyString)
        .join("\n");
      throw new ToolExecutionError(
        ERROR_MESSAGES.tools.commandFailed(
          failure.code,
          output,
          failure.message,
        ),
        { cause: error },
      );
    }
  },
  render: (_args, result) => result,
});
