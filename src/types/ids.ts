/**
 * Branded identifier types.
 *
 * Brands are compile-time only: every id is an ordinary string at runtime, so
 * these remain assignable to `string` and serialize without a wrapper. The
 * helpers are the single, explicit place where an untrusted string crosses
 * into a branded id; prefer them over scattered `as` casts.
 */

export type SessionId = string & { readonly __brand: "SessionId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type ToolCallId = string & { readonly __brand: "ToolCallId" };
export type EventLogStreamId = string & {
  readonly __brand: "EventLogStreamId";
};

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asTurnId(value: string): TurnId {
  return value as TurnId;
}

export function asToolCallId(value: string): ToolCallId {
  return value as ToolCallId;
}

export function asEventLogStreamId(value: string): EventLogStreamId {
  return value as EventLogStreamId;
}
