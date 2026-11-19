import type { JsonObjectSchema, JsonSchemaValue } from "../types/json-schema";
import type { ToolContext, ToolDefinition } from "../types/tools";

/**
 * A tool definition that retains the literal type of its schema.
 *
 * Retention matters for applications: they can derive argument types with
 * `JsonSchemaValue<typeof tool.parameters>` or inspect the exact schema
 * without widening it to the general `JsonObjectSchema` contract.
 */
export interface DefinedTool<
  TName extends string,
  TSchema extends JsonObjectSchema,
  TResult,
> extends ToolDefinition<JsonSchemaValue<TSchema>, TResult> {
  readonly name: TName;
  readonly parameters: TSchema;
}

export interface DefineToolOptions<
  TName extends string,
  TSchema extends JsonObjectSchema,
  TResult,
> {
  readonly name: TName;
  readonly description: string;
  readonly parameters: TSchema;
  /** Parse untrusted model input into the type described by `parameters`. */
  parse(input: unknown): JsonSchemaValue<TSchema>;
  execute(
    args: JsonSchemaValue<TSchema>,
    context: ToolContext,
  ): Promise<TResult> | TResult;
  render(args: JsonSchemaValue<TSchema>, result: TResult): string;
}

/**
 * Define a tool whose argument type is derived from its JSON schema.
 *
 * The schema is `const`-inferred, so `required` becomes a literal tuple and
 * each property keeps its exact schema type. That lets `execute` and `render`
 * receive a precise argument object without a hand-written interface:
 *
 * ```ts
 * const greet = defineTool({
 *   name: "greet",
 *   description: "Greet someone",
 *   parameters: {
 *     type: "object",
 *     properties: { name: { type: "string" } },
 *     required: ["name"],
 *   } as const satisfies JsonObjectSchema,
 *   parse(input) {
 *     const value = readArguments(input);
 *     return { name: requiredString(value, "name", "name is required") };
 *   },
 *   execute: ({ name }) => `Hello, ${name}!`,
 *   render: (_args, result) => result,
 * });
 * ```
 *
 * The runtime parser is still required: inference describes the declared
 * shape, but model-provided data must be validated before use.
 */
export function defineTool<
  const TName extends string,
  const TSchema extends JsonObjectSchema,
  TResult,
>(
  definition: DefineToolOptions<TName, TSchema, TResult>,
): DefinedTool<TName, TSchema, TResult> {
  return definition;
}
