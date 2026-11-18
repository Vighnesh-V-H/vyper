import type { ToolDefinition } from "../types/tools";
import { isRecord } from "../util/is-record";

/**
 * Most providers accept 1-64 characters of [A-Za-z0-9_-] for function names.
 * Enforcing one portable subset keeps adapters interchangeable.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function describe(value: Record<string, unknown>): string {
  const name = value.name;
  return typeof name === "string" && name.length > 0 ? `tool "${name}"` : "tool definition";
}

/**
 * Validate a tool before it can be registered or advertised to a model.
 * Tool definitions may come from plain JavaScript/plugins, so treat them as
 * untrusted configuration and fail loudly instead of failing per call.
 */
export function validateToolDefinition(value: unknown): asserts value is ToolDefinition {
  if (!isRecord(value)) throw new Error("Tool definition must be an object");
  const label = describe(value);

  if (typeof value.name !== "string" || !TOOL_NAME_PATTERN.test(value.name)) {
    throw new Error(`Invalid ${label} name: expected 1-64 characters matching ${TOOL_NAME_PATTERN}`);
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    throw new Error(`Invalid ${label}: description must be a non-empty string`);
  }

  const parameters = value.parameters;
  if (!isRecord(parameters)) throw new Error(`Invalid ${label}: parameters must be a JSON schema object`);
  if (parameters.type !== "object") throw new Error(`Invalid ${label}: parameters.type must be "object"`);

  const properties = parameters.properties;
  if (properties !== undefined) {
    if (!isRecord(properties)) throw new Error(`Invalid ${label}: parameters.properties must be an object`);
    for (const key of Object.keys(properties)) {
      if (key.length === 0) throw new Error(`Invalid ${label}: parameter names must not be empty`);
    }
  }

  const required = parameters.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`Invalid ${label}: parameters.required must be an array of non-empty strings`);
    }
  }

  if (parameters.additionalProperties !== undefined && typeof parameters.additionalProperties !== "boolean") {
    throw new Error(`Invalid ${label}: parameters.additionalProperties must be a boolean`);
  }

  if (typeof value.parse !== "function") throw new Error(`Invalid ${label}: parse must be a function`);
  if (typeof value.execute !== "function") throw new Error(`Invalid ${label}: execute must be a function`);
  if (typeof value.render !== "function") throw new Error(`Invalid ${label}: render must be a function`);
}
