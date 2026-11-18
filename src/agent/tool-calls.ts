import type { ToolCall } from "../types/message";
import { isRecord } from "../util/is-record";

export class InvalidToolCallsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolCallsError";
  }
}

function parseToolCall(value: unknown, label: string): ToolCall {
  if (!isRecord(value)) throw new InvalidToolCallsError(`${label} must be an object`);

  const { id, name, arguments: args } = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidToolCallsError(`${label}.id must be a non-empty string`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidToolCallsError(`${label}.name must be a non-empty string`);
  }
  if (!isRecord(args)) {
    throw new InvalidToolCallsError(`${label}.arguments must be an object`);
  }

  // Detach the top level so an adapter or event handler cannot mutate the
  // arguments object held in conversation history.
  return { id, name, arguments: { ...args } };
}

/** Validate untrusted tool calls and enforce unique ids within the set. */
export function parseToolCalls(value: unknown, label = "toolCalls"): ToolCall[] {
  if (!Array.isArray(value)) throw new InvalidToolCallsError(`${label} must be an array`);

  const calls = value.map((call, index) => parseToolCall(call, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.id)) throw new InvalidToolCallsError(`Duplicate tool call id: ${call.id}`);
    seen.add(call.id);
  }
  return calls;
}
