import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  ERROR_MESSAGES,
  ToolCancelledError,
  ToolExecutionError,
  ToolInputError,
  errorMessage,
} from "../../errors";
import type { JsonSchema, ToolDefinition } from "../../types/tools";

interface GrepArgs { pattern: string; path?: string; glob?: string }
interface Match { path: string; line: number; text: string }
const parameters: JsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regular expression to search for" },
    path: { type: "string", description: "Directory or file to search, relative to working directory" },
    glob: { type: "string", description: "Optional filename suffix/glob filter (for example *.ts)" },
  },
  required: ["pattern"],
  additionalProperties: false,
};
function parse(input: unknown): GrepArgs {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError(ERROR_MESSAGES.tools.argumentsMustBeObject);
  }
  const value = input as Record<string, unknown>;
  if (typeof value.pattern !== "string") {
    throw new ToolInputError(ERROR_MESSAGES.tools.patternMustBeString);
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    throw new ToolInputError(ERROR_MESSAGES.tools.pathMustBeString);
  }
  if (value.glob !== undefined && typeof value.glob !== "string") {
    throw new ToolInputError(ERROR_MESSAGES.tools.globMustBeString);
  }
  return { pattern: value.pattern, ...(typeof value.path === "string" ? { path: value.path } : {}), ...(typeof value.glob === "string" ? { glob: value.glob } : {}) };
}
const ignored = new Set([".git", "node_modules", ".next", "dist", "build"]);
const MAX_FILES = 2_000;
const MAX_BYTES = 2_000_000;
const MAX_MATCHES = 100;

export const grep: ToolDefinition<GrepArgs, string> = {
  name: "grep",
  description: `Search text files with a regular expression and return matching paths, line numbers, and lines.\nWHEN TO USE: Finding definitions, references, TODOs, error messages, or other text patterns across a file or directory.\nWHEN NOT TO USE: Reading a known file or a precise range of lines (use read); running shell commands (use bash); searching binary data.\nARGUMENTS:\n- pattern (string, required): JavaScript regular expression used to match each line. Invalid expressions return an error.\n- path (string, optional): File or directory relative to the working directory; defaults to ".".\n- glob (string, optional): Filename filter; supports an exact filename or a simple suffix pattern such as "*.ts".\nSearch excludes .git, node_modules, .next, dist, and build, and limits results for bounded resource use.`, 
  parameters,
  parse,
  async execute({ pattern, path = ".", glob }, { cwd, signal }) {
    let expression: RegExp;
    try {
      expression = new RegExp(pattern);
    } catch (error) {
      throw new ToolInputError(
        ERROR_MESSAGES.tools.invalidRegularExpression(errorMessage(error)),
        { cause: error },
      );
    }
    const root = await realpath(cwd);
    const start = resolve(root, path);
    const startRel = relative(root, start);
    if (startRel === ".." || startRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new ToolExecutionError(
        ERROR_MESSAGES.tools.pathOutsideWorkingDirectory,
      );
    }
    const matches: Match[] = [];
    let scanned = 0;
    let bytes = 0;
    const searchFile = async (file: string): Promise<void> => {
      if (scanned >= MAX_FILES || bytes >= MAX_BYTES || matches.length >= MAX_MATCHES) return;
      scanned++;
      const content = await readFile(file, { encoding: "utf8", signal });
      bytes += Buffer.byteLength(content);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        expression.lastIndex = 0;
        if (expression.test(lines[i]!)) matches.push({ path: relative(root, file), line: i + 1, text: lines[i]! });
      }
    };
    const matchesGlob = (name: string) => !glob || (glob.startsWith("*.") ? name.endsWith(glob.slice(1)) : name === glob);
    const visit = async (pathToVisit: string): Promise<void> => {
      if (signal.aborted || scanned >= MAX_FILES || bytes >= MAX_BYTES || matches.length >= MAX_MATCHES) return;
      const statPath = await realpath(pathToVisit);
      const rel = relative(root, statPath);
      if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return;
      const metadata = await stat(statPath);
      if (metadata.isFile()) {
        await searchFile(statPath);
        return;
      }
      if (!metadata.isDirectory()) return;
      const entries = await readdir(statPath, { withFileTypes: true });
      for (const entry of entries) {
        if (signal.aborted || scanned >= MAX_FILES || bytes >= MAX_BYTES || matches.length >= MAX_MATCHES) break;
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) await visit(resolve(statPath, entry.name));
        } else if (entry.isFile() && matchesGlob(entry.name)) {
          await searchFile(resolve(statPath, entry.name));
        }
      }
    };
    await visit(start);
    const output = matches.map((item) => `${item.path}:${item.line}: ${item.text}`);
    if (signal.aborted) throw new ToolCancelledError();
    if (scanned >= MAX_FILES || bytes >= MAX_BYTES || matches.length >= MAX_MATCHES) output.push("... results limited");
    return output.join("\n") || "No matches found.";
  },
  render: (_args, result) => result,
};
