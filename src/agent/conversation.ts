import {
  ConversationError,
  ERROR_MESSAGES,
  InvalidToolCallsError,
} from "../errors";
import type { Message, ToolCall } from "../types/message";
import { parseToolCalls } from "./tool-calls";

function validateMessageShape(message: Message, index: number): void {
  if (!message || typeof message !== "object") {
    throw new ConversationError(ERROR_MESSAGES.conversation.messageMustBeObject(index));
  }

  switch (message.role) {
    case "system":
      throw new ConversationError(ERROR_MESSAGES.conversation.systemMessage(index));
    case "user":
      if (typeof message.content !== "string") {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.contentMustBeString(index),
        );
      }
      return;
    case "assistant":
      if (message.content !== undefined && typeof message.content !== "string") {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.contentMustBeStringWhenPresent(index),
        );
      }
      return;
    case "tool":
      if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.toolCallIdMustBeNonEmptyString(index),
        );
      }
      if (typeof message.content !== "string") {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.contentMustBeString(index),
        );
      }
      return;
    default:
      throw new ConversationError(ERROR_MESSAGES.conversation.roleInvalid(index));
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
    if (!message) {
      throw new ConversationError(ERROR_MESSAGES.conversation.messageMissing(index));
    }
    validateMessageShape(message, index);

    if (message.role === "tool") {
      throw new ConversationError(ERROR_MESSAGES.conversation.orphanToolMessage(index));
    }
    if (message.role !== "assistant") {
      index++;
      continue;
    }

    const content = message.content ?? "";
    let toolCalls: ToolCall[];
    if (message.toolCalls === undefined) {
      toolCalls = [];
    } else {
      try {
        toolCalls = parseToolCalls(
          message.toolCalls,
          `messages[${index}].toolCalls`,
        );
      } catch (error) {
        if (error instanceof InvalidToolCallsError) {
          throw new ConversationError(error.message, { cause: error });
        }
        throw error;
      }
    }

    if (toolCalls.length === 0) {
      if (content.trim().length === 0) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.assistantMustContainContent(index),
        );
      }
      index++;
      continue;
    }

    for (const call of toolCalls) {
      if (seenToolCallIds.has(call.id)) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.duplicateToolCallId(call.id),
        );
      }
      seenToolCallIds.add(call.id);
    }

    for (let offset = 0; offset < toolCalls.length; offset++) {
      const call = toolCalls[offset];
      if (!call) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.missingToolCall(index, offset),
        );
      }
      const toolIndex = index + 1 + offset;
      const toolMessage = messages[toolIndex];
      if (!toolMessage) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.missingToolResult(toolIndex, call.id),
        );
      }
      validateMessageShape(toolMessage, toolIndex);
      if (toolMessage.role !== "tool") {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.expectedToolResult(toolIndex, call.id),
        );
      }
      if (toolMessage.toolCallId !== call.id) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.toolCallIdMismatch(
            toolIndex,
            call.id,
            toolMessage.toolCallId,
          ),
        );
      }
    }

    index += 1 + toolCalls.length;
  }

  return seenToolCallIds;
}
