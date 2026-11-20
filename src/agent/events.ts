import { errorMessage } from "../errors";
import type {
  AgentEvent,
  AgentEventHandler,
  AgentEventInterceptor,
  AgentInterceptBlock,
  AgentInterceptResult,
} from "../types/agent";
import { isRecord } from "../util/is-record";

export interface AgentEventChannelOptions {
  /**
   * Receives interceptor failures and observer errors. Defaults to
   * `console.error`; channel failures never change the agent run.
   */
  readonly onError?: (error: unknown) => void;
}

/** Per-dispatch handlers registered for one run without mutating the agent. */
export interface AgentEventDispatchExtras {
  readonly interceptors?: readonly AgentEventInterceptor[];
  readonly observers?: readonly AgentEventHandler[];
}

function isBlock(value: AgentInterceptResult): value is AgentInterceptBlock {
  return isRecord(value) && value.kind === "block";
}

function defaultErrorReporter(error: unknown): void {
  console.error(`Agent event handler failed: ${errorMessage(error)}`);
}

/**
 * Two independent event channels with different failure semantics:
 *
 * - Interceptors are awaited, run serially in registration order, and may
 *   rewrite the event or block it. The first block wins; later interceptors
 *   and all observers for that dispatch are skipped.
 * - Observers are read-only and non-blocking. They receive the final rewritten
 *   event after interception, and their errors are reported without failing
 *   the run.
 *
 * Registration lists are snapshotted when dispatch starts, so handlers added
 * or removed during a dispatch affect only later dispatches. Both registration
 * methods return an idempotent unsubscribe function.
 */
export class AgentEventChannels {
  readonly #interceptors = new Set<AgentEventInterceptor>();
  readonly #observers = new Set<AgentEventHandler>();
  readonly #onError: (error: unknown) => void;

  constructor(options: AgentEventChannelOptions = {}) {
    this.#onError = options.onError ?? defaultErrorReporter;
  }

  subscribe(handler: AgentEventHandler): () => void {
    this.#observers.add(handler);
    return () => {
      this.#observers.delete(handler);
    };
  }

  intercept(interceptor: AgentEventInterceptor): () => void {
    this.#interceptors.add(interceptor);
    return () => {
      this.#interceptors.delete(interceptor);
    };
  }

  async emit(
    event: AgentEvent,
    extras: AgentEventDispatchExtras = {},
  ): Promise<void> {
    const interceptors = [
      ...this.#interceptors,
      ...(extras.interceptors ?? []),
    ];
    const observers = [...this.#observers, ...(extras.observers ?? [])];

    let current = event;
    for (const interceptor of interceptors) {
      let result: AgentInterceptResult;
      try {
        result = await interceptor(current);
      } catch (error) {
        this.#report(error);
        continue;
      }

      if (result === undefined) continue;
      if (isBlock(result)) return;
      current = result;
    }

    for (const observer of observers) {
      try {
        const pending = observer(current);
        if (pending !== undefined) {
          void Promise.resolve(pending).catch((error: unknown) => {
            this.#report(error);
          });
        }
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // A broken error reporter must not affect the run either.
    }
  }
}
