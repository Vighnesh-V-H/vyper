/** Codes emitted by configuration and environment failures. */
export type ConfigurationErrorCode =
  | "configuration/invalid"
  | "configuration/missing-api-key";

/**
 * Stable, namespaced codes for every deliberate vyper failure.
 *
 * Codes are part of the public contract: callers can branch on them without
 * parsing message text. Add a code here first, then add its message and the
 * error class that uses it.
 */
export type ErrorCode =
  | ConfigurationErrorCode
  | "agent/invalid"
  | "conversation/invalid"
  | "tool-calls/invalid"
  | "tool-definition/invalid"
  | "tool-registry/duplicate"
  | "model-response/invalid"
  | "context/invalid"
  | "provider/request"
  | "provider/response"
  | "tool/invalid-input"
  | "tool/execution-failed"
  | "tool/cancelled"
  | "tool/timeout";
