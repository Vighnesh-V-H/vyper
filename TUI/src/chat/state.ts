import { AgentEventType, AgentStatus } from "../../../src/types/agent";
import type { AgentEvent, AgentResult } from "../../../src/types/agent";
import type { TokenUsage } from "../../../src/types/context";
import { formatUsage, preview } from "../format";

export type NoticeTone = "muted" | "success" | "warning" | "danger";

export interface UserTranscriptItem {
  readonly id: string;
  readonly kind: "user";
  readonly text: string;
}

export interface AssistantTranscriptItem {
  readonly id: string;
  readonly kind: "assistant";
  readonly text: string;
  readonly partial: boolean;
}

export interface ToolTranscriptItem {
  readonly id: string;
  readonly kind: "tool";
  readonly callId: string;
  readonly name: string;
  readonly status: "running" | "ok" | "error";
  readonly detail?: string;
  readonly durationMs?: number;
}

export interface NoticeTranscriptItem {
  readonly id: string;
  readonly kind: "notice";
  readonly tone: NoticeTone;
  readonly text: string;
}

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | NoticeTranscriptItem;

export type ChatPhase = "idle" | "running" | "ready" | "aborted" | "failed";

export interface ChatState {
  readonly items: readonly TranscriptItem[];
  readonly phase: ChatPhase;
  readonly step: number;
  readonly activeTool: string | undefined;
  readonly tokensEstimated: number | undefined;
  readonly usage: TokenUsage;
  readonly sessionId: string | undefined;
  readonly error: string | undefined;
  /** Monotonic id source, kept in state so the reducer stays deterministic. */
  readonly nextId: number;
}

export type ChatAction =
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "session-opened"; readonly sessionId: string }
  | { readonly type: "agent-event"; readonly event: AgentEvent }
  | { readonly type: "finished"; readonly result: AgentResult }
  | { readonly type: "cancelled" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "reset" };

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export function createInitialChatState(): ChatState {
  return {
    items: [],
    phase: "idle",
    step: 0,
    activeTool: undefined,
    tokensEstimated: undefined,
    usage: EMPTY_USAGE,
    sessionId: undefined,
    error: undefined,
    nextId: 1,
  };
}

function append(state: ChatState, item: TranscriptItem): ChatState {
  return {
    ...state,
    items: [...state.items, item],
    nextId: state.nextId + 1,
  };
}

function lastAssistantText(state: ChatState): string | undefined {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item?.kind === "assistant") return item.text;
  }
  return undefined;
}

function appendFinalOutput(state: ChatState, output: string): ChatState {
  if (output.trim().length === 0) return state;
  if (lastAssistantText(state) === output) return state;
  return append(state, {
    id: `assistant-${state.nextId}`,
    kind: "assistant",
    text: output,
    partial: false,
  });
}

function notice(
  state: ChatState,
  tone: NoticeTone,
  text: string,
): ChatState {
  return append(state, {
    id: `notice-${state.nextId}`,
    kind: "notice",
    tone,
    text,
  });
}

function hasNotice(state: ChatState, tone: NoticeTone, text: string): boolean {
  return state.items.some(
    (item) => item.kind === "notice" && item.tone === tone && item.text === text,
  );
}

function applyToolResult(
  state: ChatState,
  event: Extract<AgentEvent, { type: AgentEventType.ToolResult }>,
): ChatState {
  const { result } = event;
  let found = false;
  const items = state.items.map((item) => {
    if (item.kind !== "tool" || item.callId !== result.callId) return item;
    found = true;
    return {
      ...item,
      status: result.isError ? ("error" as const) : ("ok" as const),
      durationMs: result.durationMs,
      ...(result.isError
        ? { detail: preview(result.content, 180) }
        : { detail: undefined }),
    };
  });

  const next = found
    ? { ...state, items }
    : {
        ...state,
        items: [
          ...items,
          {
            id: `tool-${state.nextId}`,
            kind: "tool" as const,
            callId: result.callId,
            name: result.name,
            status: result.isError ? ("error" as const) : ("ok" as const),
            durationMs: result.durationMs,
            ...(result.isError
              ? { detail: preview(result.content, 180) }
              : {}),
          },
        ],
        nextId: state.nextId + 1,
      };

  const running = next.items.find(
    (item) => item.kind === "tool" && item.status === "running",
  );
  return {
    ...next,
    activeTool: running?.kind === "tool" ? running.name : undefined,
  };
}

function summaryText(result: AgentResult): string {
  const steps = `${result.steps} step${result.steps === 1 ? "" : "s"}`;
  const usage =
    result.usage.inputTokens + result.usage.outputTokens > 0
      ? ` · ${formatUsage(result.usage.inputTokens, result.usage.outputTokens)}`
      : "";
  return `${steps}${usage}`;
}

function finish(
  state: ChatState,
  result: AgentResult,
): ChatState {
  const base: ChatState = {
    ...state,
    step: result.steps,
    activeTool: undefined,
    usage: result.usage,
    error: undefined,
  };

  switch (result.status) {
    case AgentStatus.Completed: {
      const completed: ChatState = { ...base, phase: "ready" };
      const withOutput = appendFinalOutput(completed, result.output);
      return notice(withOutput, "success", `done · ${summaryText(result)}`);
    }
    case AgentStatus.MaxSteps: {
      const stopped: ChatState = { ...base, phase: "ready" };
      const withOutput = appendFinalOutput(stopped, result.output);
      return notice(withOutput, "warning", `max steps · ${summaryText(result)}`);
    }
    case AgentStatus.Aborted:
      return notice(
        { ...base, phase: "aborted" },
        "warning",
        `run aborted · partial history saved · ${summaryText(result)}`,
      );
    case AgentStatus.Error: {
      const text = preview(`${result.stage}: ${result.error.message}`, 320);
      const failed: ChatState = { ...base, phase: "failed", error: text };
      return hasNotice(failed, "danger", text)
        ? failed
        : notice(failed, "danger", text);
    }
  }
}

/**
 * Pure transcript reducer. Keeping event-to-view mapping here makes the chat
 * behavior testable without rendering or provider credentials.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "prompt":
      return {
        ...state,
        phase: "running",
        step: 0,
        activeTool: undefined,
        tokensEstimated: undefined,
        error: undefined,
        items: [
          ...state.items,
          {
            id: `user-${state.nextId}`,
            kind: "user",
            text: action.text,
          },
        ],
        nextId: state.nextId + 1,
      };

    case "session-opened":
      return { ...state, sessionId: action.sessionId };

    case "cancelled":
      return notice(
        { ...state, phase: "aborted", activeTool: undefined, error: undefined },
        "warning",
        "cancelled before the turn started",
      );

    case "failed":
      return notice(
        {
          ...state,
          phase: "failed",
          activeTool: undefined,
          error: action.message,
        },
        "danger",
        preview(action.message, 320),
      );

    case "reset":
      return createInitialChatState();

    case "finished":
      return finish(state, action.result);

    case "agent-event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case AgentEventType.StepStart:
      return { ...state, phase: "running", step: event.step };

    case AgentEventType.ContextPrepared:
      return {
        ...state,
        step: event.step,
        tokensEstimated: event.tokensEstimated,
      };

    case AgentEventType.ModelResponse: {
      const text = event.response.text ?? "";
      if (text.trim().length === 0) return state;
      return append(state, {
        id: `assistant-${state.nextId}`,
        kind: "assistant",
        text,
        partial: event.partial === true,
      });
    }

    case AgentEventType.ToolStart:
      return {
        ...append(state, {
          id: `tool-${state.nextId}`,
          kind: "tool",
          callId: event.callId,
          name: event.name,
          status: "running",
        }),
        activeTool: event.name,
      };

    case AgentEventType.ToolResult:
      return applyToolResult(state, event);

    case AgentEventType.Warning: {
      const text = preview(
        `${event.stage}: ${event.error.message}`,
        320,
      );
      return notice(state, "warning", text);
    }

    case AgentEventType.Error: {
      const text = preview(
        `${event.stage}: ${event.error.message}`,
        320,
      );
      return hasNotice(state, "danger", text)
        ? state
        : notice(state, "danger", text);
    }

    case AgentEventType.Stop:
      return state;
  }
}

export interface PhaseDescription {
  readonly label: string;
  readonly tone: NoticeTone | "accent";
}

export function describePhase(state: ChatState): PhaseDescription {
  switch (state.phase) {
    case "idle":
      return { label: "ready", tone: "muted" };
    case "running":
      if (state.activeTool !== undefined) {
        return { label: `tool ${state.activeTool}`, tone: "warning" };
      }
      return {
        label: state.step > 0 ? `step ${state.step} · waiting` : "thinking",
        tone: "accent",
      };
    case "ready":
      return { label: "ready", tone: "success" };
    case "aborted":
      return { label: "aborted", tone: "warning" };
    case "failed":
      return { label: "error", tone: "danger" };
  }
}
