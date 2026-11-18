import type { UserMessage } from "./message";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  readonly type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

export interface ToolExecutionInput {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
}

export interface ToolRunContext extends ToolExecutionInput {
  readonly cwd: string;
  deferContext(context: UserMessage): void;
  concludeTurn(): void;
}

export interface ToolContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  /**
   * Queue a user message after the current tool-result batch. With concurrent
   * tools, messages follow completion order; the default executor is sequential.
   */
  readonly deferContext?: (context: UserMessage) => void;
  /** Finish the turn after the current tool batch instead of calling the model again. */
  readonly concludeTurn?: () => void;
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> extends ToolSchema {
  /** Parse and validate untrusted model-provided arguments. Throw a useful error if invalid. */
  parse(input: unknown): TArgs;
  execute(args: TArgs, context: ToolContext): Promise<TResult> | TResult;
  /** Convert a result into bounded, plain text for the conversation. */
  render(args: TArgs, result: TResult): string;
}

/**
 * The narrow surface the agent loop and executor need from a set of tools.
 * Implement this to plug in a different catalog without adopting ToolRegistry.
 */
export interface ToolCatalog {
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
}

export type ToolExecutionErrorKind =
  | "unknown-tool"
  | "invalid-arguments"
  | "cancelled"
  | "timeout"
  | "execution";

export interface ToolExecutionResult {
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
  /** Machine-readable failure class; absent on success. */
  readonly errorKind?: ToolExecutionErrorKind;
  readonly durationMs: number;
}
