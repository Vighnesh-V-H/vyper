import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonSchema, ToolDefinition } from "../../types/tools";

interface ReadArgs { path: string; offset?: number; limit?: number }
const parameters: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path relative to the working directory" },
    offset: { type: "integer", description: "First line to return (1-indexed)" },
    limit: { type: "integer", description: "Maximum number of lines to return" },
  },
  required: ["path"],
  additionalProperties: false,
};

function parse(input: unknown): ReadArgs {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.path !== "string" || !value.path.trim()) throw new Error("path must be a non-empty string");
  if (value.offset !== undefined && (!Number.isInteger(value.offset) || (value.offset as number) < 1)) throw new Error("offset must be a positive integer");
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1)) throw new Error("limit must be a positive integer");
  return { path: value.path, ...(value.offset === undefined ? {} : { offset: value.offset as number }), ...(value.limit === undefined ? {} : { limit: value.limit as number }) };
}

export const read: ToolDefinition<ReadArgs, string> = {
  name: "read",
  description: "Read a text file from the working directory with 1-indexed line numbers.",
  parameters,
  parse,
  async execute({ path, offset = 1, limit = 500 }, { cwd, signal }) {
    if (signal.aborted) throw new Error("Tool execution cancelled");
    const root = await realpath(cwd);
    const requested = resolve(root, path);
    if (isAbsolute(path) || (relative(root, requested).startsWith("..") || relative(root, requested) === "..")) {
      throw new Error("Path must stay inside the working directory");
    }
    const file = await realpath(requested);
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("Path must stay inside the working directory");
    }
    const content = await readFile(file, { encoding: "utf8", signal });
    const allLines = content.split(/\r?\n/);
    const selected = allLines.slice(offset - 1, offset - 1 + Math.min(limit, 500));
    return selected.map((line, index) => `${offset + index}: ${line}`).join("\n") || "(empty file or no lines in requested range)";
  },
  render: (_args, result) => result,
};
