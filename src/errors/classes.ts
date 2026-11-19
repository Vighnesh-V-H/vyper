import { VyperError } from "./base";
import type { ConfigurationErrorCode } from "./codes";
import { ERROR_MESSAGES } from "./messages";

// Configuration

/** Invalid harness or application configuration. */
export class ConfigurationError extends VyperError {
  constructor(
    message: string,
    code: ConfigurationErrorCode = "configuration/invalid",
    options?: ErrorOptions,
  ) {
    super(code, message, options);
  }
}

/** A required environment variable is absent. */
export class MissingApiKeyError extends ConfigurationError {
  constructor(variable: string, options?: ErrorOptions) {
    super(
      ERROR_MESSAGES.configuration.missingApiKey(variable),
      "configuration/missing-api-key",
      options,
    );
  }
}

// Agent and conversation

/** A warning or failure raised by the agent loop itself. */
export class AgentError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("agent/invalid", message, options);
  }
}

/** Caller-supplied conversation history is malformed. */
export class ConversationError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("conversation/invalid", message, options);
  }
}

/** Untrusted tool calls are malformed or use duplicate ids. */
export class InvalidToolCallsError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("tool-calls/invalid", message, options);
  }
}

// Model and context boundaries

/** A provider response failed validation at the model trust boundary. */
export class InvalidModelResponseError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("model-response/invalid", message, options);
  }
}

/** A ContextManager returned an invalid rewrite. */
export class ContextError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("context/invalid", message, options);
  }
}

// Tools

/** A tool definition is invalid and cannot be registered or advertised. */
export class ToolDefinitionError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("tool-definition/invalid", message, options);
  }
}

/** A tool name collides with an existing registration. */
export class ToolRegistrationError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("tool-registry/duplicate", message, options);
  }
}

/** A tool received invalid arguments from the model. */
export class ToolInputError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("tool/invalid-input", message, options);
  }
}

/** A tool failed while executing a valid request. */
export class ToolExecutionError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("tool/execution-failed", message, options);
  }
}

/** A tool stopped because its execution signal was aborted. */
export class ToolCancelledError extends VyperError {
  constructor(options?: ErrorOptions) {
    super("tool/cancelled", ERROR_MESSAGES.tools.executionCancelled, options);
  }
}

/** A tool exceeded the executor's time limit. */
export class ToolTimeoutError extends VyperError {
  constructor(timeoutMs?: number, options?: ErrorOptions) {
    super("tool/timeout", ERROR_MESSAGES.executor.timedOut(timeoutMs), options);
  }
}

// Provider adapters

/** A provider request could not be completed. */
export class ProviderRequestError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("provider/request", message, options);
  }
}

/** A provider response did not match the expected wire shape. */
export class ProviderResponseError extends VyperError {
  constructor(message: string, options?: ErrorOptions) {
    super("provider/response", message, options);
  }
}
