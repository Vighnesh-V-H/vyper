import { CharTokenMeter } from "./token-meter";
import type {
  ContextManager,
  PrepareContextInput,
  PreparedContext,
  TokenUsage,
} from "../types/context";
import type { Message } from "../types/message";

export interface WindowedContextOptions {
  /** Estimated token budget for the conversation. */
  readonly maxTokens: number;
  /** Number of trailing messages retained after trimming. */
  readonly keepMessages: number;
}

/**
 * Keeps the conversation under a token budget by dropping old turns.
 *
 * Trimming starts at the first user message in the retained suffix. That keeps
 * assistant/tool call pairs intact, which the agent validates before use.
 */
export class WindowedContext implements ContextManager {
  readonly #meter = new CharTokenMeter();
  readonly #maxTokens: number;
  readonly #keepMessages: number;

  constructor(options: WindowedContextOptions) {
    this.#maxTokens = options.maxTokens;
    this.#keepMessages = options.keepMessages;
  }

  async prepare({ messages }: PrepareContextInput): Promise<PreparedContext> {
    const tokensEstimated = this.#meter.estimate(messages);
    if (tokensEstimated <= this.#maxTokens) {
      return { messages: [...messages], compacted: false, tokensEstimated };
    }

    const start = this.#findTrimStart(messages);
    const kept = messages.slice(start);
    return {
      messages: [...kept],
      compacted: start > 0,
      tokensEstimated: this.#meter.estimate(kept),
    };
  }

  observe(usage: TokenUsage): void {
    this.#meter.record(usage);
  }

  #findTrimStart(messages: readonly Message[]): number {
    let start = Math.max(0, messages.length - this.#keepMessages);
    while (start < messages.length && messages[start]?.role !== "user") start += 1;
    return start < messages.length ? start : 0;
  }
}
