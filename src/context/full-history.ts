import { CharTokenMeter } from "./token-meter";
import type {
  ContextManager,
  PrepareContextInput,
  PreparedContext,
  TokenUsage,
} from "../types/context";

/** Preserve the complete conversation for each model request without trimming. */
export class FullHistoryContext implements ContextManager {
  readonly #meter = new CharTokenMeter();

  async prepare({ messages }: PrepareContextInput): Promise<PreparedContext> {
    return {
      messages: [...messages],
      compacted: false,
      tokensEstimated: this.#meter.estimate(messages),
    };
  }

  observe(usage: TokenUsage): void {
    this.#meter.record(usage);
  }
}
