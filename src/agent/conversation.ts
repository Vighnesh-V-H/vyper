import type { Message } from "../types/message";
import { parseToolCalls } from "./tool-calls";

function validateMessageShape(message: Message, index: number): void {
  if (!message || typeof message !== "object") {
    throw new TypeError(`messages[${index}] must be an object`);
  }

  switch (message.role) {
    case "system":
      throw new TypeError(
        `messages[${index}] must not be a system message; pass instructions via AgentOptions.instructions`,
      );
    case "user":
      if (typeof message.content !== "string") {
        throw new TypeError(`messages[${index}].content must be a string`);
      }
      return;
    case "assistant":
      if (message.content !== undefined && typeof message.content !== "string") {
        throw new TypeError(`messages[${index}].content must be a string when present`);
      }
      return;
    case "tool":
      if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
        throw new TypeError(`messages[${index}].toolCallId must be a non-empty string`);
      }
      if (typeof message.content !== "string") {
        throw new TypeError(`messages[${index}].content must be a string`);
      }
      return;
    default:
      throw new TypeError(`messages[${index}].role is invalid`);
  }
}

/**
 * Merge adjacent user messages. Some providers reject consecutive user turns,
 * and deferred context can otherwise create one across run boundaries.
 */
export function normalizeConversation(messages: readonly Message[]): Message[] {
  const normalized: Message[] = [];
  for (const message of messages) {
    const previous = normalized[normalized.length - 1];
    if (
      message &&
      typeof message === "object" &&
      message.role === "user" &&
      typeof message.content === "string" &&
      previous?.role === "user" &&
      typeof previous.content === "string"
    ) {
      normalized[normalized.length - 1] = {
        role: "user",
        content: `${previous.content}\n\n${message.content}`,
      };
    } else {
      normalized.push(message);
    }
  }
  return normalized;
}

/** Append user content, merging into a trailing user turn when necessary. */
export function appendUserMessage(messages: Message[], content: string): void {
  const previous = messages[messages.length - 1];
  if (previous?.role === "user") {
    messages[messages.length - 1] = {
      role: "user",
      content: `${previous.content}\n\n${content}`,
    };
    return;
  }
  messages.push({ role: "user", content });
}

/**
 * Validate caller-supplied history before it reaches a provider. This keeps
 * malformed assistant/tool pairs from becoming opaque provider 400s.
 */
export function validateConversation(messages: readonly Message[]): Set<string> {
  const seenToolCallIds = new Set<string>();
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!message) throw new TypeError(`messages[${index}] is missing`);
    validateMessageShape(message, index);

    if (message.role === "tool") {
      throw new TypeError(`messages[${index}] is an orphan tool message`);
    }
    if (message.role !== "assistant") {
      index++;
      continue;
    }

    const content = message.content ?? "";
    const toolCalls =
      message.toolCalls === undefined
        ? []
        : parseToolCalls(message.toolCalls, `messages[${index}].toolCalls`);

    if (toolCalls.length === 0) {
      if (content.trim().length === 0) {
        throw new TypeError(`messages[${index}] assistant message must contain text or tool calls`);
      }
      index++;
      continue;
    }

    for (const call of toolCalls) {
      if (seenToolCallIds.has(call.id)) {
        throw new TypeError(`Duplicate tool call id in conversation: ${call.id}`);
      }
      seenToolCallIds.add(call.id);
    }

    for (let offset = 0; offset < toolCalls.length; offset++) {
      const call = toolCalls[offset];
      if (!call) throw new TypeError(`messages[${index}].toolCalls[${offset}] is missing`);
      const toolIndex = index + 1 + offset;
      const toolMessage = messages[toolIndex];
      if (!toolMessage) {
        throw new TypeError(
          `messages[${toolIndex}] is missing; expected a tool result for call ${call.id}`,
        );
      }
      validateMessageShape(toolMessage, toolIndex);
      if (toolMessage.role !== "tool") {
        throw new TypeError(
          `messages[${toolIndex}] must be a tool result for call ${call.id}`,
        );
      }
      if (toolMessage.toolCallId !== call.id) {
        throw new TypeError(
          `messages[${toolIndex}].toolCallId must be ${call.id}, received ${toolMessage.toolCallId}`,
        );
      }
    }

    index += 1 + toolCalls.length;
  }

  return seenToolCallIds;
}
