import { ERROR_MESSAGES, SessionLogError } from "../errors";
import { AgentStatus } from "../types/agent";
import type {
  AgentEventHandler,
  AgentResult,
  AgentRunOptions,
} from "../types/agent";
import type { TurnId } from "../types/ids";
import type { Message } from "../types/message";
import type { ChatAgent } from "../types/session";
import type { SessionLog } from "./log";
import { SessionRecorder } from "./recorder";

export interface ChatSessionOptions {
  /** Extra per-session observer; the agent keeps its own observers. */
  readonly onEvent?: AgentEventHandler;
  /** Injectable turn-id factory for deterministic tests. */
  readonly createTurnId?: () => TurnId;
}

export interface ChatSessionOpenOptions extends ChatSessionOptions {
  readonly agent: ChatAgent;
  /** An opened, validated session log. */
  readonly session: SessionLog;
}

/**
 * Tracks conversation history across agent runs.
 *
 * The agent loop is stateless: each run receives a conversation and returns
 * the next one. This session feeds that result back in as the starting point
 * for the following turn.
 *
 * Completed and max-steps turns are committed. Aborted turns keep the previous
 * committed conversation. Failed turns are retracted from projection while
 * their records remain in storage.
 *
 * A session created with `open()` also records the full turn lifecycle through
 * a `SessionRecorder`, and resumes the last committed conversation from the
 * log.
 */
export class ChatSession {
  readonly #agent: ChatAgent;
  readonly #onEvent: AgentEventHandler | undefined;
  #session: SessionLog | undefined;
  #recorder: SessionRecorder | undefined;
  #messages: readonly Message[] = [];
  #controller: AbortController | undefined;

  constructor(agent: ChatAgent, options: ChatSessionOptions = {}) {
    this.#agent = agent;
    this.#onEvent = options.onEvent;
  }

  /** Open a persisted session, resuming its last committed conversation. */
  static async open(options: ChatSessionOpenOptions): Promise<ChatSession> {
    const session = new ChatSession(options.agent, options);
    session.#session = options.session;
    session.#recorder = new SessionRecorder({
      log: options.session,
      ...(options.createTurnId === undefined
        ? {}
        : { createTurnId: options.createTurnId }),
    });

    const snapshot = await options.session.snapshot();
    if (snapshot.interruptedTurnId !== undefined) {
      await options.session.retractTurn(
        snapshot.interruptedTurnId,
        "interrupted turn",
      );
      await options.session.flush();
    }
    session.#messages = snapshot.messages;
    return session;
  }

  /** Identifier of the backing session log, when persisted. */
  get sessionId() {
    return this.#session?.sessionId;
  }

  /** True when this session records to a durable log. */
  get isPersistent(): boolean {
    return this.#session !== undefined;
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

  /** Forget the committed conversation and append a reset marker when durable. */
  async reset(): Promise<void> {
    if (this.#controller !== undefined) {
      throw new SessionLogError(ERROR_MESSAGES.chat.resetWhileRunning);
    }
    if (this.#recorder !== undefined) await this.#recorder.reset();
    this.#messages = [];
  }

  /** Run one user turn and commit its history when it completes. */
  async ask(prompt: string): Promise<AgentResult> {
    if (this.#controller !== undefined) {
      throw new SessionLogError(ERROR_MESSAGES.chat.turnInProgress);
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
      const interceptor =
        this.#recorder === undefined
          ? undefined
          : await this.#recorder.start(prompt);
      const runOptions: AgentRunOptions = {
        signal: controller.signal,
        ...(interceptor === undefined ? {} : { interceptors: [interceptor] }),
        ...(this.#onEvent === undefined ? {} : { onEvent: this.#onEvent }),
      };

      const result = await this.#agent.run(input, runOptions);
      // Record before committing in-memory history: if durability fails, the
      // session must not advance past what is actually stored.
      if (this.#recorder !== undefined) await this.#recorder.finish(result);
      if (
        result.status === AgentStatus.Completed ||
        result.status === AgentStatus.MaxSteps
      ) {
        this.#messages = result.messages;
      }
      return result;
    } catch (error) {
      if (this.#recorder !== undefined) await this.#recorder.fail(error);
      throw error;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  /** Flush and close the backing log, when present. Idempotent. */
  async close(): Promise<void> {
    if (this.#controller !== undefined) {
      throw new SessionLogError(ERROR_MESSAGES.chat.closeWhileRunning);
    }
    if (this.#session !== undefined) await this.#session.close();
  }
}
