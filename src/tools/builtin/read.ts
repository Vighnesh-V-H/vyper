import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  ERROR_MESSAGES,
  ToolCancelledError,
  ToolExecutionError,
} from "../../errors";
import type { JsonObjectSchema, JsonSchemaValue } from "../../types/json-schema";
import { omitUndefined } from "../../util/omit-undefined";
import {
  optionalPositiveInteger,
  readArguments,
  requiredNonBlankString,
} from "../arguments";
import { defineTool } from "../define-tool";
import { assertInsideRoot } from "../path-safety";

const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File path relative to the working directory",
    },
    offset: {
      type: "integer",
      description: "First line to return (1-indexed)",
    },
    limit: {
      type: "integer",
      description: "Maximum number of lines to return",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const satisfies JsonObjectSchema;

type ReadArgs = JsonSchemaValue<typeof parameters>;

function parse(input: unknown): ReadArgs {
  const value = readArguments(input);
  return omitUndefined({
    path: requiredNonBlankString(
      value,
      "path",
      ERROR_MESSAGES.tools.pathMustBeNonEmptyString,
    ),
    offset: optionalPositiveInteger(
      value,
      "offset",
      ERROR_MESSAGES.tools.offsetMustBePositiveInteger,
    ),
    limit: optionalPositiveInteger(
      value,
      "limit",
      ERROR_MESSAGES.tools.limitMustBePositiveInteger,
    ),
  });
}

function resolveReadPath(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new ToolExecutionError(
      ERROR_MESSAGES.tools.pathOutsideWorkingDirectory,
    );
  }
  const requested = resolve(root, path);
  assertInsideRoot(root, requested);
  return requested;
}

export const read = defineTool({
  name: "read",
  description: `Read a text file from the working directory and return numbered lines.\nWHEN TO USE: Inspecting a known source file, configuration file, or other text file; reading a specific range of lines.\nWHEN NOT TO USE: Searching across files (use grep); running commands (use bash); reading binary files or files outside the working directory.\nARGUMENTS:\n- path (string, required): File path relative to the working directory.\n- offset (integer, optional): First line to return, 1-indexed; defaults to 1.\n- limit (integer, optional): Maximum lines to return; defaults to 500 and is capped at 500.`,
  parameters,
  parse,
  async execute({ path, offset = 1, limit = 500 }, { cwd, signal }) {
    if (signal.aborted) throw new ToolCancelledError();
    const root = await realpath(cwd);
    const requested = resolveReadPath(root, path);
    const file = await realpath(requested);
    assertInsideRoot(root, file);

    const content = await readFile(file, { encoding: "utf8", signal });
    const allLines = content.split(/\r?\n/);
    const selected = allLines.slice(offset - 1, offset - 1 + Math.min(limit, 500));
    return (
      selected
        .map((line, index) => `${offset + index}: ${line}`)
        .join("\n") || "(empty file or no lines in requested range)"
    );
  },
  render: (_args, result) => result,
});
