import { Agent } from "../../../src/agent/agent";
import { MissingApiKeyError, errorMessage } from "../../../src/errors";
import { FileEventLog } from "../../../src/event-log/file";
import { createPromptSessionId } from "../../../src/cli";
import { FullHistoryContext } from "../../../src/context/full-history";
import { GeminiModel } from "../../../src/providers/gemini";
import { SessionEventCodec } from "../../../src/session/codec";
import { ChatSession } from "../../../src/session/chat";
import { SessionLog } from "../../../src/session/log";
import type { AgentEventHandler } from "../../../src/types/agent";
import { asSessionId } from "../../../src/types/ids";
import type { SessionEvent } from "../../../src/types/session";
import type { TuiConfig } from "../types";

export interface OpenChatOptions {
  readonly config: TuiConfig;
  readonly firstPrompt: string;
  readonly onEvent: AgentEventHandler;
}

export interface OpenChatResult {
  readonly chat: ChatSession;
  readonly sessionId: string;
}

/**
 * Build the same production agent used by the CLI, but wire it to a TUI event
 * observer and a prompt-named durable session.
 */
export async function openChatSession(
  options: OpenChatOptions,
): Promise<OpenChatResult> {
  const { config, firstPrompt, onEvent } = options;
  if (config.apiKey === undefined) {
    throw new MissingApiKeyError("GOOGLE_GENERATIVE_AI_API_KEY");
  }

  const agent = new Agent({
    model: new GeminiModel({ apiKey: config.apiKey, model: config.model }),
    instructions: config.instructions,
    tools: config.tools,
    context: new FullHistoryContext(),
    cwd: config.cwd,
    maxSteps: config.maxSteps,
    toolConcurrency: config.toolConcurrency,
    onEventError: () => {
      // Observer failures must never corrupt the terminal or the run.
    },
  });

  const sessionId = createPromptSessionId(firstPrompt);
  const codec = new SessionEventCodec();
  const session = await SessionLog.open({
    log: new FileEventLog<SessionEvent>({
      directory: config.sessionDirectory,
      codec,
    }),
    codec,
    sessionId: asSessionId(sessionId),
    model: config.model,
    instructions: config.instructions,
    cwd: config.cwd,
    appConfig: {
      interface: "tui",
      maxSteps: config.maxSteps,
      preserveFullHistory: true,
    },
  });

  try {
    const chat = await ChatSession.open({ agent, session, onEvent });
    return { chat, sessionId };
  } catch (error) {
    await session.close().catch(() => {
      // The open failure is the useful error; cleanup failures are secondary.
    });
    throw error;
  }
}

/** Small indirection so the hook never prints an unhelpful `[object Object]`. */
export function describeError(error: unknown): string {
  return errorMessage(error);
}
