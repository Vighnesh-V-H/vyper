/** Every error code is namespaced as `namespace/name`. */
export type ErrorCodeShape = `${string}/${string}`;

/**
 * Stable, namespaced codes for every deliberate vyper failure.
 *
 * Codes are part of the public contract: callers can branch on them without
 * parsing message text. Add a member here first, then add its message and the
 * error class that uses it.
 */
export enum ErrorCode {
  ConfigurationInvalid = "configuration/invalid",
  MissingApiKey = "configuration/missing-api-key",
  AgentInvalid = "agent/invalid",
  ConversationInvalid = "conversation/invalid",
  ToolCallsInvalid = "tool-calls/invalid",
  ToolDefinitionInvalid = "tool-definition/invalid",
  ToolRegistryDuplicate = "tool-registry/duplicate",
  ModelResponseInvalid = "model-response/invalid",
  ContextInvalid = "context/invalid",
  ProviderRequest = "provider/request",
  ProviderResponse = "provider/response",
  ToolInvalidInput = "tool/invalid-input",
  ToolExecutionFailed = "tool/execution-failed",
  ToolCancelled = "tool/cancelled",
  ToolTimeout = "tool/timeout",
  EventLogInvalid = "event-log/invalid",
  EventLogPoisoned = "event-log/poisoned",
  SessionLogInvalid = "session-log/invalid",
}

/** Codes accepted by ConfigurationError. */
export type ConfigurationErrorCode =
  | ErrorCode.ConfigurationInvalid
  | ErrorCode.MissingApiKey;
