import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ChatSession } from "../../../src/session/chat";
import type { TuiConfig } from "../types";
import { describeError, openChatSession } from "./session";
import {
  chatReducer,
  createInitialChatState,
  type ChatState,
} from "./state";

export interface ChatController {
  readonly state: ChatState;
  readonly busy: boolean;
  send(text: string): Promise<void>;
  abort(): void;
  startNew(): Promise<void>;
}

/**
 * Owns the live ChatSession and maps its event stream into transcript state.
 * The hook is deliberately thin: process rules live in the reducer, persistence
 * lives in the harness, and this file only handles lifecycle.
 */
export function useChat(config: TuiConfig): ChatController {
  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    createInitialChatState,
  );
  const chatRef = useRef<ChatSession | undefined>(undefined);
  const busyRef = useRef(false);

  useEffect(() => {
    return () => {
      const chat = chatRef.current;
      chatRef.current = undefined;
      if (chat === undefined) return;
      chat.abort();
      void chat.close().catch(() => {
        // The process is leaving; a busy turn may reject close.
      });
    };
  }, []);

  const send = useCallback(
    async (raw: string): Promise<void> => {
      const prompt = raw.trim();
      if (prompt.length === 0 || busyRef.current) return;

      busyRef.current = true;
      dispatch({ type: "prompt", text: prompt });

      try {
        if (config.apiKey === undefined) {
          dispatch({
            type: "failed",
            message:
              "GOOGLE_GENERATIVE_AI_API_KEY is not set. Add it to .env and restart.",
          });
          return;
        }

        let chat = chatRef.current;
        if (chat === undefined) {
          const opened = await openChatSession({
            config,
            firstPrompt: prompt,
            onEvent: (event) => dispatch({ type: "agent-event", event }),
          });
          chat = opened.chat;
          chatRef.current = chat;
          dispatch({ type: "session-opened", sessionId: opened.sessionId });
        }

        const result = await chat.ask(prompt);
        dispatch({ type: "finished", result });
      } catch (error) {
        dispatch({ type: "failed", message: describeError(error) });
      } finally {
        busyRef.current = false;
      }
    },
    [config],
  );

  const abort = useCallback((): void => {
    chatRef.current?.abort();
  }, []);

  const startNew = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    // Hold the send gate while the old log closes, so a prompt submitted in
    // between cannot be wiped by the reset below.
    busyRef.current = true;
    try {
      const chat = chatRef.current;
      chatRef.current = undefined;
      if (chat !== undefined) {
        await chat.close().catch(() => {
          // Closing a session must not block starting a fresh one.
        });
      }
      dispatch({ type: "reset" });
    } finally {
      busyRef.current = false;
    }
  }, []);

  return {
    state,
    busy: state.phase === "running",
    send,
    abort,
    startNew,
  };
}
