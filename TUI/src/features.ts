import type { TuiConfig } from "./types";

export interface Feature {
  readonly area: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * A concise inventory of the harness built so far. Keep this honest: every
 * claim below maps to a module that exists in this repository.
 */
export const FEATURES: readonly Feature[] = [
  {
    area: "agent",
    title: "Provider-neutral agent loop",
    detail:
      "Typed model, tool, context, and event contracts. Explicit termination, cancellation, max-step limits, and validated model output.",
  },
  {
    area: "providers",
    title: "Gemini adapter",
    detail:
      "Plain fetch transport with tool declarations, usage accounting, and thought-signature replay for multi-turn tool calls.",
  },
  {
    area: "tools",
    title: "Pluggable tool execution",
    detail:
      "JSON-schema validated inputs, path containment, bounded results, timeouts, and optional concurrent execution.",
  },
  {
    area: "context",
    title: "Replaceable context managers",
    detail:
      "Full-history and token-window strategies sit behind the same ContextManager contract. The loop never owns context policy.",
  },
  {
    area: "sessions",
    title: "Durable, prompt-named sessions",
    detail:
      "Append-only JSONL event logs, replay, resume, retractions, and failed-turn rollback. Every turn is recorded before it is committed.",
  },
  {
    area: "safety",
    title: "Sandbox contracts",
    detail:
      "Normalization, policy decisions, approvals, grants, audit records, and a sandbox executor boundary live outside the core loop.",
  },
  {
    area: "quality",
    title: "Tested seams",
    detail:
      "The loop runs without provider credentials. Tests cover tool round trips, malformed input, cancellation, replay, and session recovery.",
  },
];

export function featureCount(): number {
  return FEATURES.length;
}

export function providerLabel(config: TuiConfig): string {
  return config.apiKey === undefined ? "not configured" : "configured";
}
