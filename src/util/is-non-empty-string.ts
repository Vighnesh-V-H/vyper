/** True for a string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
