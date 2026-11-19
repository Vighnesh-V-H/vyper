import type { AgentRunOptions, AgentResult } from "./types/agent";
import { AgentStatus } from "./types/agent";
import type { Message } from "./types/message";

/** The narrow agent contract a chat session needs. */
export interface ChatAgent {
  run(
    input: string | readonly Message[],
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
}

/**
 * Tracks conversation history across agent runs.
 *
 * The agent loop is intentionally stateless: each run receives a conversation
 * and returns the next one. This session feeds that result back in as the
 * starting point for the following turn.
 *
 * Completed and max-steps turns are committed. Aborted and failed turns are
 * rolled back so a retry does not inherit half-finished tool work or merge the
 * failed prompt into the next user message.
 */
export class ChatSession {
  readonly #agent: ChatAgent;
  #messages: readonly Message[] = [];
  #controller: AbortController | undefined;

  constructor(agent: ChatAgent) {
    this.#agent = agent;
  }

  /** Conversation committed by the last successful turn. */
  get messages(): readonly Message[] {
    return this.#messages;
  }

  /** True while a turn is awaiting the agent. */
  get isRunning(): boolean {
    return this.#controller !== undefined;
  }

  /** Abort the in-flight turn, if any. */
  abort(): void {
    this.#controller?.abort();
  }

  /** Forget the conversation; the next turn starts fresh. */
  reset(): void {
    this.#messages = [];
  }

  /** Run one user turn and commit its history when it completes. */
  async ask(prompt: string): Promise<AgentResult> {
    if (this.#controller !== undefined) {
      throw new Error("A chat turn is already in progress.");
    }

    const controller = new AbortController();
    this.#controller = controller;
    const previous = this.#messages;
    // A string starts a fresh conversation; later turns pass the whole history
    // so the agent can validate and plan against prior tool calls.
    const input: string | readonly Message[] =
      previous.length === 0
        ? prompt
        : [...previous, { role: "user", content: prompt }];

    try {
      const result = await this.#agent.run(input, {
        signal: controller.signal,
      });
      if (
        result.status === AgentStatus.Completed ||
        result.status === AgentStatus.MaxSteps
      ) {
        this.#messages = result.messages;
      }
      return result;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }
}
