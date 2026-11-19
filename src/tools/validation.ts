import { ERROR_MESSAGES, ToolDefinitionError } from "../errors";
import type { JsonSchema } from "../types/json-schema";
import type { ToolDefinition } from "../types/tools";
import { isNonEmptyString } from "../util/is-non-empty-string";
import { isRecord } from "../util/is-record";

/**
 * Most providers accept 1-64 characters of [A-Za-z0-9_-] for function names.
 * Enforcing one portable subset keeps adapters interchangeable.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message: string): never {
  throw new ToolDefinitionError(message);
}

function describe(value: Record<string, unknown>): string {
  const name = value.name;
  return isNonEmptyString(name) ? `tool "${name}"` : "tool definition";
}

function isEnumValue(value: unknown, type: "string" | "number" | "boolean"): boolean {
  return typeof value === type;
}

/**
 * Recursively validate a JSON schema. The result is a type guard rather than a
 * cast at the tool trust boundary, so malformed nested property schemas cannot
 * be advertised to a provider.
 */
export function isJsonSchema(value: unknown): value is JsonSchema {
  if (!isRecord(value)) return false;
  if (value.description !== undefined && typeof value.description !== "string") {
    return false;
  }

  switch (value.type) {
    case "object":
      if (value.properties !== undefined) {
        if (!isRecord(value.properties)) return false;
        if (
          !Object.entries(value.properties).every(
            ([key, schema]) => key.length > 0 && isJsonSchema(schema),
          )
        ) {
          return false;
        }
      }
      if (
        value.required !== undefined &&
        (!Array.isArray(value.required) ||
          !value.required.every(isNonEmptyString))
      ) {
        return false;
      }
      return (
        value.additionalProperties === undefined ||
        typeof value.additionalProperties === "boolean"
      );
    case "array":
      return value.items === undefined || isJsonSchema(value.items);
    case "string":
      return (
        value.enum === undefined ||
        (Array.isArray(value.enum) &&
          value.enum.every((item) => isEnumValue(item, "string")))
      );
    case "number":
    case "integer":
      return (
        value.enum === undefined ||
        (Array.isArray(value.enum) &&
          value.enum.every((item) => isEnumValue(item, "number")))
      );
    case "boolean":
      return (
        value.enum === undefined ||
        (Array.isArray(value.enum) &&
          value.enum.every((item) => isEnumValue(item, "boolean")))
      );
    case "null":
      return true;
    default:
      return false;
  }
}

/**
 * Validate a tool before it can be registered or advertised to a model.
 * Tool definitions may come from plain JavaScript/plugins, so treat them as
 * untrusted configuration and fail loudly instead of failing per call.
 */
export function validateToolDefinition(value: unknown): asserts value is ToolDefinition {
  if (!isRecord(value)) {
    invalid(ERROR_MESSAGES.toolDefinition.mustBeObject);
  }
  const label = describe(value);

  if (typeof value.name !== "string" || !TOOL_NAME_PATTERN.test(value.name)) {
    invalid(ERROR_MESSAGES.toolDefinition.invalidName(label, TOOL_NAME_PATTERN));
  }
  if (
    typeof value.description !== "string" ||
    value.description.trim().length === 0
  ) {
    invalid(ERROR_MESSAGES.toolDefinition.descriptionMustBeNonEmptyString(label));
  }

  const parameters = value.parameters;
  if (!isRecord(parameters)) {
    invalid(ERROR_MESSAGES.toolDefinition.parametersMustBeSchemaObject(label));
  }
  if (!isJsonSchema(parameters)) {
    invalid(ERROR_MESSAGES.toolDefinition.parametersMustBeValidSchema(label));
  }
  if (parameters.type !== "object") {
    invalid(ERROR_MESSAGES.toolDefinition.parametersTypeMustBeObject(label));
  }

  const properties = parameters.properties;
  if (properties !== undefined) {
    for (const key of Object.keys(properties)) {
      if (key.length === 0) {
        invalid(ERROR_MESSAGES.toolDefinition.parameterNamesMustNotBeEmpty(label));
      }
    }
  }

  const required = parameters.required;
  if (required !== undefined) {
    if (
      !Array.isArray(required) ||
      required.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      invalid(ERROR_MESSAGES.toolDefinition.requiredMustBeStringArray(label));
    }
  }

  if (
    parameters.additionalProperties !== undefined &&
    typeof parameters.additionalProperties !== "boolean"
  ) {
    invalid(ERROR_MESSAGES.toolDefinition.additionalPropertiesMustBeBoolean(label));
  }

  if (typeof value.parse !== "function") {
    invalid(ERROR_MESSAGES.toolDefinition.parseMustBeFunction(label));
  }
  if (typeof value.execute !== "function") {
    invalid(ERROR_MESSAGES.toolDefinition.executeMustBeFunction(label));
  }
  if (typeof value.render !== "function") {
    invalid(ERROR_MESSAGES.toolDefinition.renderMustBeFunction(label));
  }
}
