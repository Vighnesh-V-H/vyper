import {
  ConversationError,
  ERROR_MESSAGES,
  InvalidToolCallsError,
} from "../errors";
import type { ToolCallId } from "../types/ids";
import type { Message, ToolCall } from "../types/message";
import { isNonEmptyString } from "../util/is-non-empty-string";
import { parseToolCalls } from "./tool-calls";

type UserMessage = Extract<Message, { role: "user" }>;

function isUserText(message: Message | undefined): message is UserMessage {
  return message?.role === "user" && typeof message.content === "string";
}

function mergeUserContent(previous: string, next: string): string {
  return `${previous}\n\n${next}`;
}

function requireStringContent(message: Message, index: number): void {
  if (typeof message.content !== "string") {
    throw new ConversationError(
      ERROR_MESSAGES.conversation.contentMustBeString(index),
    );
  }
}

function validateMessageShape(message: Message, index: number): void {
  if (!message || typeof message !== "object") {
    throw new ConversationError(
      ERROR_MESSAGES.conversation.messageMustBeObject(index),
    );
  }

  switch (message.role) {
    case "system":
      throw new ConversationError(
        ERROR_MESSAGES.conversation.systemMessage(index),
      );
    case "user":
      return requireStringContent(message, index);
    case "assistant":
      if (message.content !== undefined && typeof message.content !== "string") {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.contentMustBeStringWhenPresent(index),
        );
      }
      return;
    case "tool":
      if (!isNonEmptyString(message.toolCallId)) {
        throw new ConversationError(
          ERROR_MESSAGES.conversation.toolCallIdMustBeNonEmptyString(index),
        );
      }
      return requireStringContent(message, index);
    default:
      throw new ConversationError(
        ERROR_MESSAGES.conversation.roleInvalid(index),
      );
  }
}

/**
 * Merge adjacent user messages. Some providers reject consecutive user turns,
 * and deferred context can otherwise create one across run boundaries.
 */
export function normalizeConversation(messages: readonly Message[]): Message[] {
  const normalized: Message[] = [];
  for (const message of messages) {
    const previous = normalized.at(-1);
    if (isUserText(message) && isUserText(previous)) {
      normalized[normalized.length - 1] = {
        role: "user",
        content: mergeUserContent(previous.content, message.content),
      };
    } else {
      normalized.push(message);
    }
  }
  return normalized;
}

/** Append user content, merging into a trailing user turn when necessary. */
export function appendUserMessage(messages: Message[], content: string): void {
  const previous = messages.at(-1);
  if (previous?.role === "user") {
    messages[messages.length - 1] = {
      role: "user",
      content: mergeUserContent(previous.content, content),
    };
    return;
  }
  messages.push({ role: "user", content });
}

/** Parse an assistant message's tool calls, wrapping parse errors. */
function parseAssistantToolCalls(message: Message, index: number): ToolCall[] {
  if (message.role !== "assistant" || message.toolCalls === undefined) {
    return [];
  }
  try {
    return parseToolCalls(message.toolCalls, `messages[${index}].toolCalls`);
  } catch (error) {
    if (error instanceof InvalidToolCallsError) {
      throw new ConversationError(error.message, { cause: error });
    }
    throw error;
  }
}

/** Each tool call must be followed by its matching tool result, in order. */
function validateToolResults(
  messages: readonly Message[],
  assistantIndex: number,
  toolCalls: readonly ToolCall[],
): void {
  for (const [offset, call] of toolCalls.entries()) {
    const toolIndex = assistantIndex + 1 + offset;
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
}

/**
 * Validate caller-supplied history before it reaches a provider. This keeps
 * malformed assistant/tool pairs from becoming opaque provider 400s.
 */
export function validateConversation(messages: readonly Message[]): Set<ToolCallId> {
  const seenToolCallIds = new Set<ToolCallId>();

  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (!message) {
      throw new ConversationError(
        ERROR_MESSAGES.conversation.messageMissing(index),
      );
    }
    validateMessageShape(message, index);

    if (message.role === "tool") {
      throw new ConversationError(
        ERROR_MESSAGES.conversation.orphanToolMessage(index),
      );
    }
    if (message.role !== "assistant") {
      index++;
      continue;
    }

    const toolCalls = parseAssistantToolCalls(message, index);

    if (toolCalls.length === 0) {
      if ((message.content ?? "").trim() === "") {
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

    validateToolResults(messages, index, toolCalls);
    index += 1 + toolCalls.length;
  }

  return seenToolCallIds;
}
