import { ERROR_MESSAGES, ToolDefinitionError } from "../errors";
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
  if (!isRecord(value)) {
    throw new ToolDefinitionError(ERROR_MESSAGES.toolDefinition.mustBeObject);
  }
  const label = describe(value);

  if (typeof value.name !== "string" || !TOOL_NAME_PATTERN.test(value.name)) {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.invalidName(label, TOOL_NAME_PATTERN),
    );
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.descriptionMustBeNonEmptyString(label),
    );
  }

  const parameters = value.parameters;
  if (!isRecord(parameters)) {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.parametersMustBeSchemaObject(label),
    );
  }
  if (parameters.type !== "object") {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.parametersTypeMustBeObject(label),
    );
  }

  const properties = parameters.properties;
  if (properties !== undefined) {
    if (!isRecord(properties)) {
      throw new ToolDefinitionError(
        ERROR_MESSAGES.toolDefinition.propertiesMustBeObject(label),
      );
    }
    for (const key of Object.keys(properties)) {
      if (key.length === 0) {
        throw new ToolDefinitionError(
          ERROR_MESSAGES.toolDefinition.parameterNamesMustNotBeEmpty(label),
        );
      }
    }
  }

  const required = parameters.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new ToolDefinitionError(
        ERROR_MESSAGES.toolDefinition.requiredMustBeStringArray(label),
      );
    }
  }

  if (parameters.additionalProperties !== undefined && typeof parameters.additionalProperties !== "boolean") {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.additionalPropertiesMustBeBoolean(label),
    );
  }

  if (typeof value.parse !== "function") {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.parseMustBeFunction(label),
    );
  }
  if (typeof value.execute !== "function") {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.executeMustBeFunction(label),
    );
  }
  if (typeof value.render !== "function") {
    throw new ToolDefinitionError(
      ERROR_MESSAGES.toolDefinition.renderMustBeFunction(label),
    );
  }
}
