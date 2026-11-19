import type { ErrorCode } from "./codes";

/**
 * Base class for every error raised deliberately by vyper.
 *
 * A stable `code` lets callers distinguish configuration mistakes, provider
 * failures, and malformed model output without inspecting message text.
 * `new.target.name` keeps the concrete class name correct without repeating
 * it in every constructor.
 */
export abstract class VyperError extends Error {
  readonly code: ErrorCode;

  protected constructor(
    code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
