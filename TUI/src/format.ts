import { homedir } from "node:os";

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Remove terminal escape sequences and control characters from model/tool output. */
export function stripAnsi(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARACTERS, "");
}

/** Flatten arbitrary tool output into a single bounded line. */
export function preview(value: string, maxLength = 160): string {
  const flat = stripAnsi(value).replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatUsage(inputTokens: number, outputTokens: number): string {
  return `${formatTokenCount(inputTokens)} in · ${formatTokenCount(outputTokens)} out`;
}

/** Shorten a path under the user's home directory for status displays. */
export function displayPath(path: string, home = homedir()): string {
  if (path === home) return "~";
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Trim a long identifier without losing the distinguishing suffix. */
export function shortId(value: string, maxLength = 44): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(-(maxLength - 1))}`;
}
