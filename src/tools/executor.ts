import type {
  ToolCatalog,
  ToolContext,
  ToolExecutionErrorKind,
  ToolExecutionResult,
} from "../types/tools";
import { omitUndefined } from "../util/omit-undefined";

export interface ToolExecutionRequest {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: string;
  /** Untrusted model output. The tool's parse() must validate it. */
  readonly arguments: unknown;
}

export interface ExecuteToolOptions extends ToolContext, ToolExecutionRequest {
  /** One-shot override for the engine-level timeout. */
  readonly timeoutMs?: number;
  /** One-shot override for the rendered-output cap. */
  readonly maxResultChars?: number;
}

export interface ToolExecutionEngineOptions {
  /** Per-call timeout. Undefined means no engine-level timeout. */
  readonly timeoutMs?: number;
  /** Cap for rendered tool output. Defaults to 100k characters. */
  readonly maxResultChars?: number;
  /** Maximum concurrent calls in executeMany(). Defaults to 1 (sequential). */
  readonly concurrency?: number;
}

export interface ToolExecutionCallbacks {
  /** Called when a call enters the executor, including cancelled/unknown calls. */
  readonly onStart?: (request: ToolExecutionRequest) => void;
  /** Called as each result settles, in completion order. */
  readonly onResult?: (result: ToolExecutionResult) => void;
}

function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (!callback) return;
  try {
    callback(value);
  } catch {
    // Observability callbacks must not affect execution.
  }
}

const DEFAULT_MAX_RESULT_CHARS = 100_000;

class ToolAbortError extends Error {
  constructor() {
    super("Tool execution cancelled");
    this.name = "ToolAbortError";
  }
}

class ToolTimeoutError extends Error {
  constructor() {
    super("Tool execution timed out");
    this.name = "ToolTimeoutError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  return String(error);
}

/** Bound text to exactly maxChars when truncation is needed. */
function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n... [truncated ${text.length - maxChars} characters]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("timeoutMs must be a positive number");
  return value;
}

function normalizeMaxResultChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULT_CHARS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("maxResultChars must be a positive integer");
  }
  return value;
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("concurrency must be a positive integer");
  }
  return value;
}

/**
 * Executes tool calls with explicit cancellation, timeout, result bounding,
 * and error classification.
 *
 * Tool-level failures never throw: they become isError results that the model
 * can read and react to. Cancellation is cooperative — the engine stops
 * waiting even if a tool ignores its signal, but it cannot undo side effects.
 */
export class ToolExecutionEngine {
  readonly #catalog: ToolCatalog;
  readonly #timeoutMs: number | undefined;
  readonly #maxResultChars: number;
  readonly #concurrency: number;

  constructor(catalog: ToolCatalog, options: ToolExecutionEngineOptions = {}) {
    if (!catalog || typeof catalog.get !== "function" || typeof catalog.list !== "function") {
      throw new TypeError("Tool catalog must provide get() and list()");
    }
    this.#catalog = catalog;
    this.#timeoutMs = normalizeTimeout(options.timeoutMs);
    this.#maxResultChars = normalizeMaxResultChars(options.maxResultChars);
    this.#concurrency = normalizeConcurrency(options.concurrency);
  }

  async execute(
    request: ToolExecutionRequest,
    context: ToolContext,
    callbacks?: ToolExecutionCallbacks,
  ): Promise<ToolExecutionResult> {
    notify(callbacks?.onStart, request);
    const startedAt = Date.now();
    const complete = (result: ToolExecutionResult): ToolExecutionResult => {
      notify(callbacks?.onResult, result);
      return result;
    };
    const fail = (kind: ToolExecutionErrorKind, content: string): ToolExecutionResult =>
      complete({
        callId: request.callId,
        name: request.name,
        content: boundText(content, this.#maxResultChars),
        isError: true,
        errorKind: kind,
        durationMs: Date.now() - startedAt,
      });

    if (context.signal.aborted) return fail("cancelled", "Tool execution cancelled");

    const tool = this.#catalog.get(request.name);
    if (!tool) return fail("unknown-tool", `Unknown tool: ${request.name}`);

    let args: unknown;
    try {
      args = tool.parse(request.arguments);
    } catch (error) {
      return fail("invalid-arguments", `Invalid arguments for ${request.name}: ${errorMessage(error)}`);
    }

    if (context.signal.aborted) return fail("cancelled", "Tool execution cancelled");

    const timeoutSignal = this.#timeoutMs === undefined ? undefined : AbortSignal.timeout(this.#timeoutMs);
    const signal = timeoutSignal ? AbortSignal.any([context.signal, timeoutSignal]) : context.signal;
    const toolContext: ToolContext = {
      cwd: context.cwd,
      signal,
      ...(context.deferContext ? { deferContext: context.deferContext } : {}),
      ...(context.concludeTurn ? { concludeTurn: context.concludeTurn } : {}),
    };

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        const timedOut = timeoutSignal?.aborted === true && !context.signal.aborted;
        reject(timedOut ? new ToolTimeoutError() : new ToolAbortError());
      };
      if (signal.aborted) {
        abort();
        return;
      }
      onAbort = abort;
      signal.addEventListener("abort", abort, { once: true });
    });

    let result: unknown;
    try {
      result = await Promise.race([Promise.resolve(tool.execute(args, toolContext)), aborted]);
    } catch (error) {
      const timedOut = timeoutSignal?.aborted === true && !context.signal.aborted;
      if (timedOut) {
        return fail("timeout", `Tool execution timed out after ${this.#timeoutMs} ms`);
      }
      if (context.signal.aborted) return fail("cancelled", "Tool execution cancelled");
      return fail("execution", `Tool ${request.name} failed: ${errorMessage(error)}`);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }

    if (context.signal.aborted) return fail("cancelled", "Tool execution cancelled");
    if (timeoutSignal?.aborted === true) {
      return fail("timeout", `Tool execution timed out after ${this.#timeoutMs} ms`);
    }

    let rendered: unknown;
    try {
      rendered = tool.render(args, result);
    } catch (error) {
      return fail("execution", `Tool ${request.name} failed to render its result: ${errorMessage(error)}`);
    }
    if (typeof rendered !== "string") {
      return fail("execution", `Tool ${request.name} render() must return a string`);
    }

    return complete({
      callId: request.callId,
      name: request.name,
      content: boundText(rendered, this.#maxResultChars),
      isError: false,
      durationMs: Date.now() - startedAt,
    });
  }

  /**
   * Execute a batch while preserving input order in the returned array.
   * Concurrency is bounded by the engine setting; the default is sequential.
   */
  async executeMany(
    requests: readonly ToolExecutionRequest[],
    context: ToolContext,
    callbacks?: ToolExecutionCallbacks,
  ): Promise<ToolExecutionResult[]> {
    if (requests.length === 0) return [];
    const results = new Array<ToolExecutionResult>(requests.length);
    const workerCount = Math.min(this.#concurrency, requests.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= requests.length) return;
        const request = requests[index];
        if (!request) return;
        results[index] = await this.execute(request, context, callbacks);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
}

/** One-shot convenience wrapper for applications that do not need an engine. */
export async function executeTool(
  catalog: ToolCatalog,
  options: ExecuteToolOptions,
): Promise<ToolExecutionResult> {
  const engine = new ToolExecutionEngine(
    catalog,
    omitUndefined({
      timeoutMs: options.timeoutMs,
      maxResultChars: options.maxResultChars,
    }),
  );
  return engine.execute(options, options);
}
