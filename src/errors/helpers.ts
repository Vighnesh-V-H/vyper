import { VyperError } from "./base";

/** True when a value is a deliberately raised vyper error. */
export function isVyperError(value: unknown): value is VyperError {
  return value instanceof VyperError;
}

/** Best-effort, non-empty message for any thrown value. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message.length > 0 ? value.message : value.name;
  }
  return String(value);
}

/** Normalize an unknown thrown value into an Error, preserving its cause. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value), { cause: value });
}
