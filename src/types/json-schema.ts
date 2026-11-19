/**
 * Provider-neutral JSON Schema model and type-level schema inference.
 *
 * Tool arguments cross a trust boundary: the model can send anything, so the
 * runtime parser remains authoritative. These types make the *declaration*
 * side safe: a tool's schema and its implementation cannot drift apart, and
 * consumers can derive the parsed argument type without a second interface.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonSchemaBase {
  readonly description?: string;
}

export interface JsonObjectSchema extends JsonSchemaBase {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface JsonArraySchema extends JsonSchemaBase {
  readonly type: "array";
  readonly items?: JsonSchema;
}

export interface JsonStringSchema extends JsonSchemaBase {
  readonly type: "string";
  readonly enum?: readonly string[];
}

export interface JsonNumberSchema extends JsonSchemaBase {
  readonly type: "number";
  readonly enum?: readonly number[];
}

export interface JsonIntegerSchema extends JsonSchemaBase {
  readonly type: "integer";
  readonly enum?: readonly number[];
}

export interface JsonBooleanSchema extends JsonSchemaBase {
  readonly type: "boolean";
  readonly enum?: readonly boolean[];
}

export interface JsonNullSchema extends JsonSchemaBase {
  readonly type: "null";
}

/** A discriminated union, so `schema.type` narrows the allowed keywords. */
export type JsonSchema =
  | JsonObjectSchema
  | JsonArraySchema
  | JsonStringSchema
  | JsonNumberSchema
  | JsonIntegerSchema
  | JsonBooleanSchema
  | JsonNullSchema;

/** Flatten an intersection so inferred object types are readable. */
type Simplify<T> = { [K in keyof T]: T[K] };

type SchemaProperties<S extends JsonSchema> =
  S extends { readonly properties?: infer TProperties }
    ? TProperties extends Readonly<Record<string, JsonSchema>>
      ? TProperties
      : {}
    : {};

type SchemaRequired<S extends JsonSchema> =
  S extends { readonly required?: infer TRequired }
    ? TRequired extends readonly string[]
      ? TRequired
      : readonly []
    : readonly [];

/**
 * Object properties are required only when their name appears in `required`.
 * The mapped type below also removes the `readonly` modifiers that `as const`
 * schemas introduce, because parsed arguments are ordinary mutable objects.
 *
 * Binding the properties to `P` inside the conditional keeps each `P[K]`
 * constrained to `JsonSchema`; indexing the conditional helper directly makes
 * the compiler lose that constraint for unresolved `S`.
 */
type JsonObjectValue<S extends JsonSchema> =
  SchemaProperties<S> extends infer P extends Readonly<Record<string, JsonSchema>>
    ? Simplify<
        {
          -readonly [K in Extract<
            keyof P,
            SchemaRequired<S>[number]
          >]: JsonSchemaValue<P[K]>;
        } & {
          -readonly [K in Exclude<
            keyof P,
            SchemaRequired<S>[number]
          >]?: JsonSchemaValue<P[K]>;
        }
      >
    : never;

/**
 * Derive the TypeScript value described by a schema literal.
 *
 * This is intentionally a *value* inference, not a validator: integers are
 * represented as `number`, and `additionalProperties` cannot be expressed
 * precisely without index-signature trickery. The runtime parser still decides
 * whether untrusted input is valid.
 */
export type JsonSchemaValue<S extends JsonSchema> =
  S extends { readonly enum: readonly (infer TValue)[] }
    ? TValue
    : S extends { readonly type: "object" }
      ? JsonObjectValue<S>
      : S extends { readonly type: "array" }
        ? S extends { readonly items: infer TItems extends JsonSchema }
          ? JsonSchemaValue<TItems>[]
          : JsonValue[]
        : S extends { readonly type: "string" }
          ? string
          : S extends { readonly type: "number" | "integer" }
            ? number
            : S extends { readonly type: "boolean" }
              ? boolean
              : S extends { readonly type: "null" }
                ? null
                : never;
