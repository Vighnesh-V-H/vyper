import type { Message } from "./message";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TokenMeter {
  /** Provider-reported input tokens from the last successful call, if any. */
  readonly lastInputTokens: number | undefined;

  /** Estimate tokens for a list of messages. Fuzzy is fine; consistency matters more than precision. */
  estimate(messages: Message[]): number;

  /** Estimate tokens for a bare string, e.g. a system prompt. */
  measureText(text: string): number;

  /** Record provider-reported usage after a model call. */
  record(usage: TokenUsage): void;
}

export interface ContextBudget {
  /** The model's total context window. Required — it is model-specific. */
  contextWindow: number;

  /** Headroom reserved for the next model output. Pi defaults to 16_384. */
  reserveTokens?: number;

  /** Recent context to keep verbatim. Pi defaults to 20_000. */
  keepRecentTokens?: number;

  /** Compact when estimated tokens exceed this fraction of the window. Codex/Eve use 0.9. */
  compactThreshold?: number;
}

export type CompactionTrigger = "threshold" | "overflow" | "manual";

export interface CompactionDetails {
  readFiles?: string[];
  modifiedFiles?: string[];
  [key: string]: unknown;
}

export interface CompactionResult {
  messages: Message[];
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  trigger: CompactionTrigger;
  details?: CompactionDetails;
}

export interface PrepareContextInput {
  messages: Message[];
  /** Static agent instructions or assembled system prompt. */
  system?: string;
  signal?: AbortSignal;
}

export interface PreparedContext {
  messages: Message[];
  system?: string;
  /** True when prepare() compacted or otherwise rewrote history. */
  compacted: boolean;
  tokensEstimated: number;
}

export interface ContextManager {
  /**
   * Called immediately before every model call.
   * Must be pure-ish: it may rewrite history, but it should not mutate the input array.
   */
  prepare(input: PrepareContextInput): Promise<PreparedContext>;

  /**
   * Called after every model response so the manager can calibrate estimates
   * against provider-reported usage.
   */
  observe(usage: TokenUsage, messages: Message[]): void;

  /**
   * Optional explicit compaction. The agent loop calls this on overflow
   * or when the user invokes /compact.
   */
  compact?(input: {
    messages: Message[];
    trigger: CompactionTrigger;
    signal?: AbortSignal;
  }): Promise<CompactionResult>;
}

export interface SummarizeInput {
  messages: Message[];
  previousSummary?: string;
  signal?: AbortSignal;
}

export interface Summarizer {
  summarize(input: SummarizeInput): Promise<{
    summary: string;
    details?: CompactionDetails;
  }>;
}

export interface ContextCheckpoint {
  id: string;
  summary: string;
  /** Index into the pre-compaccction message array of the first message kept verbatim. */
  firstKeptMessageIndex: number;
  createdAt: number;
  details?: CompactionDetails;
}

export interface ContextStore {
  save(checkpoint: ContextCheckpoint): Promise<void>;
  latest(sessionId: string): Promise<ContextCheckpoint | null>;
}

export type ContextSource =
  | { kind: "project-file"; path: string; content: string; priority: number }
  | { kind: "memory"; id: string; content: string; priority: number }
  | { kind: "retrieval"; uri: string; content: string; priority: number }
  | { kind: "runtime"; key: string; value: string; priority: number };

export interface ContextAssembler {
  assemble(input: {
    cwd: string;
    sources: ContextSource[];
    signal?: AbortSignal;
  }): Promise<{ system: string }>;
}
