import { ERROR_MESSAGES, ToolInputError } from "../errors";
import { isRecord } from "../util/is-record";

/** Treat model-provided tool arguments as an untrusted plain object. */
export function readArguments(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ToolInputError(ERROR_MESSAGES.tools.argumentsMustBeObject);
  }
  return input;
}

/** Read a required string argument. */
export function requiredString(
  args: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = args[key];
  if (typeof value !== "string") throw new ToolInputError(message);
  return value;
}

/** Read a required string that must contain non-whitespace content. */
export function requiredNonBlankString(
  args: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(message);
  }
  return value;
}

/** Read an optional string argument. */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
  message: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolInputError(message);
  return value;
}

/** Read an optional positive integer argument. */
export function optionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
  message: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError(message);
  }
  return value;
}
