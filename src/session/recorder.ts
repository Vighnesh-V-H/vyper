import {
  ERROR_MESSAGES,
  SessionLogError,
  errorMessage,
  isVyperError,
  toError,
} from "../errors";
import { AgentEventType, AgentStatus } from "../types/agent";
import type {
  AgentEvent,
  AgentEventInterceptor,
  AgentResult,
} from "../types/agent";
import type { TurnId } from "../types/ids";
import { asTurnId } from "../types/ids";
import type { SessionErrorInfo, SessionEvent } from "../types/session";
import { SessionEventType } from "../types/session";
import type { ToolExecutionResult } from "../types/tools";
import { omitUndefined } from "../util/omit-undefined";
import { persistedModelResponse } from "./codec";
import type { SessionLog } from "./log";

const MAX_ERROR_CAUSE_DEPTH = 8;

export interface SessionRecorderOptions {
  readonly log: SessionLog;
  /** Injectable turn-id factory for deterministic tests. */
  readonly createTurnId?: () => TurnId;
}

function defaultTurnId(): TurnId {
  return asTurnId(crypto.randomUUID());
}

function sessionErrorInfo(error: Error, depth = 0): SessionErrorInfo {
  const cause =
    depth < MAX_ERROR_CAUSE_DEPTH && error.cause instanceof Error
      ? sessionErrorInfo(error.cause, depth + 1)
      : undefined;
  return omitUndefined({
    name: error.name,
    message: error.message,
    code: isVyperError(error) ? error.code : undefined,
    cause,
  });
}

function cloneToolResult(result: ToolExecutionResult): ToolExecutionResult {
  return omitUndefined({
    callId: result.callId,
    name: result.name,
    content: result.content,
    isError: result.isError,
    errorKind: result.errorKind,
    durationMs: result.durationMs,
  });
}

/**
 * Map an agent event to its durable session counterpart. `Stop` is lifecycle
 * bookkeeping handled by `finish()`, not a session event of its own.
 */
function toSessionEvent(
  turnId: TurnId,
  event: AgentEvent,
): SessionEvent | undefined {
  switch (event.type) {
    case AgentEventType.StepStart:
      return {
        type: SessionEventType.StepStarted,
        turnId,
        step: event.step,
      };

    case AgentEventType.ContextPrepared:
      return {
        type: SessionEventType.ContextPrepared,
        turnId,
        step: event.step,
        compacted: event.compacted,
        tokensEstimated: event.tokensEstimated,
      };

    case AgentEventType.ModelResponse:
      return {
        type: SessionEventType.ModelResponded,
        turnId,
        step: event.step,
        response: persistedModelResponse(event.response),
      };

    case AgentEventType.ToolStart:
      return {
        type: SessionEventType.ToolStarted,
        turnId,
        step: event.step,
        callId: event.callId,
        name: event.name,
      };

    case AgentEventType.ToolResult:
      return {
        type: SessionEventType.ToolCompleted,
        turnId,
        step: event.step,
        result: cloneToolResult(event.result),
      };

    case AgentEventType.Warning:
      return {
        type: SessionEventType.Warning,
        turnId,
        step: event.step,
        stage: event.stage,
        error: sessionErrorInfo(event.error),
      };

    case AgentEventType.Error:
      return {
        type: SessionEventType.Error,
        turnId,
        step: event.step,
        stage: event.stage,
        error: sessionErrorInfo(event.error),
      };

    case AgentEventType.Stop:
      return undefined;
  }
}

/**
 * Records one agent turn into a `SessionLog`.
 *
 * Flow:
 * 1. `start()` appends TurnStarted and returns an interceptor.
 * 2. The interceptor maps each agent event to a session event and appends it.
 * 3. `finish()` appends a validated TurnFinished, or retracts the whole turn
 *    when the run failed or an event could not be recorded.
 *
 * Recording errors never poison the log unless the underlying append failed.
 * A non-JSON model response is caught before append, so the turn can still be
 * retracted cleanly.
 */
export class SessionRecorder {
  readonly #log: SessionLog;
  readonly #createTurnId: () => TurnId;
  #turn: { readonly turnId: TurnId } | undefined;
  #recordingError: Error | undefined;
  #persistenceError: Error | undefined;

  constructor(options: SessionRecorderOptions) {
    this.#log = options.log;
    this.#createTurnId = options.createTurnId ?? defaultTurnId;
  }

  get isRecording(): boolean {
    return this.#turn !== undefined;
  }

  /** Append TurnStarted and return the interceptor for this run. */
  async start(prompt: string): Promise<AgentEventInterceptor> {
    if (this.#turn !== undefined) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionRecorder.turnAlreadyActive,
      );
    }

    const turnId = this.#createTurnId();
    await this.#log.append({
      type: SessionEventType.TurnStarted,
      turnId,
      prompt,
    });
    await this.#log.flush();

    this.#turn = { turnId };
    this.#recordingError = undefined;
    this.#persistenceError = undefined;
    return (event) => this.#intercept(event);
  }

  /**
   * Finish the current turn. Completed/max-steps runs commit their full
   * message snapshot; aborted runs keep the previous one; failed runs and
   * recording failures retract the turn.
   */
  async finish(result: AgentResult): Promise<void> {
    const turn = this.#turn;
    if (turn === undefined) {
      throw new SessionLogError(ERROR_MESSAGES.sessionRecorder.noActiveTurn);
    }
    this.#turn = undefined;

    try {
      if (this.#persistenceError !== undefined) {
        throw this.#persistenceError;
      }

      if (this.#recordingError !== undefined) {
        const recordingError = this.#recordingError;
        await this.#log.retractTurn(
          turn.turnId,
          ERROR_MESSAGES.sessionRecorder.recordingFailed(
            recordingError.message,
          ),
        );
        await this.#log.flush();
        throw recordingError;
      }

      if (result.status === AgentStatus.Error) {
        await this.#log.retractTurn(turn.turnId, errorMessage(result.error));
      } else if (result.status === AgentStatus.Aborted) {
        await this.#log.finishTurn(turn.turnId, {
          status: AgentStatus.Aborted,
        });
      } else {
        await this.#log.finishTurn(turn.turnId, {
          status: result.status,
          messages: result.messages,
        });
      }
      await this.#log.flush();
    } finally {
      this.#recordingError = undefined;
      this.#persistenceError = undefined;
    }
  }

  /**
   * Retract a turn whose agent run threw instead of returning a result. The
   * caller rethrows the original error after this succeeds.
   */
  async fail(error: unknown): Promise<void> {
    const turn = this.#turn;
    if (turn === undefined) return;
    this.#turn = undefined;

    try {
      if (this.#persistenceError !== undefined) {
        throw this.#persistenceError;
      }
      await this.#log.retractTurn(
        turn.turnId,
        errorMessage(this.#recordingError ?? error),
      );
      await this.#log.flush();
    } finally {
      this.#recordingError = undefined;
      this.#persistenceError = undefined;
    }
  }

  /** Append a durable reset marker. */
  async reset(): Promise<void> {
    if (this.#turn !== undefined) {
      throw new SessionLogError(
        ERROR_MESSAGES.sessionRecorder.turnAlreadyActive,
      );
    }
    await this.#log.append({ type: SessionEventType.Reset });
    await this.#log.flush();
  }

  async #intercept(event: AgentEvent): Promise<AgentEvent> {
    const turn = this.#turn;
    if (turn === undefined) return event;
    if (
      this.#recordingError !== undefined ||
      this.#persistenceError !== undefined
    ) {
      return event;
    }

    let sessionEvent: SessionEvent | undefined;
    try {
      sessionEvent = toSessionEvent(turn.turnId, event);
    } catch (error) {
      // Mapping validates JSON safety (tool arguments) before any append, so
      // this does not poison the log.
      this.#recordingError = toError(error);
      return event;
    }
    if (sessionEvent === undefined) return event;

    try {
      await this.#log.append(sessionEvent);
    } catch (error) {
      // An append failure poisons the session log; surface it at finish.
      this.#persistenceError = toError(error);
    }
    return event;
  }
}
