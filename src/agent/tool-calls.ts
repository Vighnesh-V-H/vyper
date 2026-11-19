import { ERROR_MESSAGES, InvalidToolCallsError } from "../errors";
import type { ToolCall } from "../types/message";
import { isRecord } from "../util/is-record";

function parseToolCall(value: unknown, label: string): ToolCall {
  if (!isRecord(value)) {
    throw new InvalidToolCallsError(ERROR_MESSAGES.toolCalls.mustBeObject(label));
  }

  const { id, name, arguments: args } = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidToolCallsError(
      ERROR_MESSAGES.toolCalls.idMustBeNonEmptyString(label),
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidToolCallsError(
      ERROR_MESSAGES.toolCalls.nameMustBeNonEmptyString(label),
    );
  }
  if (!isRecord(args)) {
    throw new InvalidToolCallsError(
      ERROR_MESSAGES.toolCalls.argumentsMustBeObject(label),
    );
  }

  // Detach the top level so an adapter or event handler cannot mutate the
  // arguments object held in conversation history.
  return { id, name, arguments: { ...args } };
}

/** Validate untrusted tool calls and enforce unique ids within the set. */
export function parseToolCalls(value: unknown, label = "toolCalls"): ToolCall[] {
  if (!Array.isArray(value)) {
    throw new InvalidToolCallsError(ERROR_MESSAGES.toolCalls.mustBeArray(label));
  }

  const calls = value.map((call, index) => parseToolCall(call, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.id)) {
      throw new InvalidToolCallsError(ERROR_MESSAGES.toolCalls.duplicateId(call.id));
    }
    seen.add(call.id);
  }
  return calls;
}
