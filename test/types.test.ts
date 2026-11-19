import { describe, expect, test } from "bun:test";
import { ErrorCode } from "../src/errors";
import type { ErrorCodeShape } from "../src/errors";
import {
  optionalPositiveInteger,
  readArguments,
  requiredNonBlankString,
} from "../src/tools/arguments";
import { defineTool } from "../src/tools/define-tool";
import { AgentEventType, AgentStatus } from "../src/types";
import type {
  AgentEventOfType,
  AgentFailedResult,
  AgentResultOfStatus,
  AgentToolResultEvent,
  JsonObjectSchema,
  JsonSchemaValue,
} from "../src/types";
import { omitUndefined } from "../src/util/omit-undefined";

/** Compile-time assertion helpers; failures surface in `bun check`. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

const nestedSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    profile: {
      type: "object",
      properties: { active: { type: "boolean" } },
      required: ["active"],
    },
  },
  required: ["name", "profile"],
  additionalProperties: false,
} as const satisfies JsonObjectSchema;

type NestedArgs = JsonSchemaValue<typeof nestedSchema>;

type _NestedKeys = Assert<
  Equal<keyof NestedArgs, "name" | "profile" | "age" | "tags">
>;
type _RequiredName = Assert<Equal<NestedArgs["name"], string>>;
type _OptionalAge = Assert<Equal<NestedArgs["age"], number | undefined>>;
type _OptionalTags = Assert<Equal<NestedArgs["tags"], string[] | undefined>>;
type _NestedProfile = Assert<
  Equal<NestedArgs["profile"], { active: boolean }>
>;

const enumSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["fast", "safe"] },
    empty: { type: "null" },
    matrix: {
      type: "array",
      items: { type: "array", items: { type: "number" } },
    },
  },
  required: ["mode", "empty", "matrix"],
} as const satisfies JsonObjectSchema;

type EnumArgs = JsonSchemaValue<typeof enumSchema>;

type _EnumMode = Assert<Equal<EnumArgs["mode"], "fast" | "safe">>;
type _NullValue = Assert<Equal<EnumArgs["empty"], null>>;
type _NestedArrays = Assert<Equal<EnumArgs["matrix"], number[][]>>;

const echoSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    count: { type: "integer" },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies JsonObjectSchema;

const echo = defineTool({
  name: "echo",
  description: "Echo text a number of times.",
  parameters: echoSchema,
  parse(input) {
    const value = readArguments(input);
    return omitUndefined({
      text: requiredNonBlankString(
        value,
        "text",
        "text must be a non-empty string",
      ),
      count: optionalPositiveInteger(
        value,
        "count",
        "count must be a positive integer",
      ),
    });
  },
  execute(args) {
    return args.text.repeat(args.count ?? 1);
  },
  render: (_args, result) => result,
});

type _EchoName = Assert<Equal<typeof echo.name, "echo">>;
type _EchoArgs = Assert<
  Equal<Parameters<typeof echo.execute>[0], { text: string; count?: number }>
>;
type _EchoResult = Assert<
  Equal<Awaited<ReturnType<typeof echo.execute>>, string>
>;

/** `const` type parameters must preserve literals without an `as const`. */
const inline = defineTool({
  name: "inline",
  description: "Tool with an inline schema.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  parse(input) {
    const value = readArguments(input);
    return {
      value: requiredNonBlankString(value, "value", "value is required"),
    };
  },
  execute: ({ value }) => value,
  render: (_args, result) => result,
});

type _InlineArgs = Assert<
  Equal<Parameters<typeof inline.execute>[0], { value: string }>
>;

type _ToolResultEvent = Assert<
  Equal<AgentEventOfType<AgentEventType.ToolResult>, AgentToolResultEvent>
>;
type _FailedResult = Assert<
  Equal<AgentResultOfStatus<AgentStatus.Error>, AgentFailedResult>
>;
type _NamespacedCodes = Assert<ErrorCode extends ErrorCodeShape ? true : false>;

describe("type-level contracts", () => {
  test("defineTool infers arguments from its schema", () => {
    expect(echo.parse({ text: "a", count: 2 })).toEqual({
      text: "a",
      count: 2,
    });
    expect(echo.parameters.required).toEqual(["text"]);
    expect(inline.parse({ value: "preserved" })).toEqual({ value: "preserved" });
  });

  test("event and result lookups stay discriminant-compatible", () => {
    const event: AgentEventOfType<AgentEventType.ToolStart> = {
      type: AgentEventType.ToolStart,
      step: 1,
      callId: "call-1",
      name: "clock",
    };
    expect(event.type).toBe(AgentEventType.ToolStart);
  });
});
