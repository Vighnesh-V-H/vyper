import { isAbsolute, relative } from "node:path";
import { ERROR_MESSAGES, ToolExecutionError } from "../errors";

const PATH_SEPARATOR = process.platform === "win32" ? "\\" : "/";

/**
 * True when target is outside root. Handles parent traversal and the
 * different-drive case where path.relative() returns an absolute path.
 */
export function isOutsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === ".." ||
    rel.startsWith(`..${PATH_SEPARATOR}`) ||
    isAbsolute(rel)
  );
}

/** Reject a path that would escape the working directory. */
export function assertInsideRoot(root: string, target: string): void {
  if (isOutsideRoot(root, target)) {
    throw new ToolExecutionError(
      ERROR_MESSAGES.tools.pathOutsideWorkingDirectory,
    );
  }
}
