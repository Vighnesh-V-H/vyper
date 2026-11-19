import {
  ERROR_MESSAGES,
  ProviderRequestError,
  ProviderResponseError,
} from "../errors";
import type { TokenUsage } from "../types/context";
import type { Message, ToolCall } from "../types/message";
import type { Model, ModelResponse, ModelTool } from "../types/model";
import { isRecord } from "../util/is-record";
import { omitUndefined } from "../util/omit-undefined";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type GenerateInput = Parameters<Model["generate"]>[0];

type GeminiPart =
  | { text: string }
  | {
      functionCall: { name: string; args: Record<string, unknown> };
      thoughtSignature?: string;
    }
  | {
      functionResponse: {
        id?: string;
        name: string;
        response: { result: string };
      };
    };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiModelOptions {
  readonly apiKey: string;
  readonly model: string;
}

/**
 * Gemini provider adapter.
 *
 * The agent loop only knows the Model contract. HTTP details, Gemini message
 * shapes, and thought signatures stay behind this file.
 */
export class GeminiModel implements Model {
  readonly #apiKey: string;
  readonly #model: string;
  // Gemini 3 requires thought signatures to be echoed back with function calls.
  readonly #signatures = new Map<string, string>();

  constructor(options: GeminiModelOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
  }

  async generate(input: GenerateInput): Promise<ModelResponse> {
    const response = await fetch(this.#endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.#apiKey,
      },
      body: JSON.stringify(this.#requestBody(input)),
      signal: input.signal,
    });

    if (!response.ok) {
      throw new ProviderRequestError(await describeHttpError(response));
    }
    return parseResponse(await response.json(), this.#signatures);
  }

  #endpoint(): string {
    return `${API_BASE}/${encodeURIComponent(this.#model)}:generateContent`;
  }

  #requestBody(input: GenerateInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(input.messages, this.#signatures),
    };

    const system = collectSystemPrompt(input.messages);
    if (system.length > 0) body.systemInstruction = { parts: [{ text: system }] };
    if (input.tools.length > 0) {
      body.tools = [{ functionDeclarations: input.tools.map(toFunctionDeclaration) }];
    }

    return body;
  }
}

function collectSystemPrompt(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") parts.push(message.content);
  }
  return parts.join("\n\n");
}

/** Gemini accepts standard JSON Schema through parametersJsonSchema. */
function toFunctionDeclaration(tool: ModelTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  };
}

function toGeminiContents(
  messages: readonly Message[],
  signatures: ReadonlyMap<string, string>,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "system":
        // The system prompt travels through systemInstruction instead.
        break;
      case "user":
        appendParts(contents, "user", [{ text: message.content }]);
        break;
      case "assistant": {
        const parts: GeminiPart[] = [];
        if (message.content !== undefined && message.content.length > 0) {
          parts.push({ text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          toolNames.set(call.id, call.name);
          parts.push(
            omitUndefined({
              functionCall: { name: call.name, args: call.arguments },
              thoughtSignature: signatures.get(call.id),
            }),
          );
        }
        appendParts(contents, "model", parts);
        break;
      }
      case "tool": {
        const name = toolNames.get(message.toolCallId);
        if (name === undefined) {
          throw new ProviderResponseError(
            ERROR_MESSAGES.gemini.missingToolResultMapping(message.toolCallId),
          );
        }
        appendParts(contents, "user", [
          {
            functionResponse: {
              id: message.toolCallId,
              name,
              response: { result: message.content },
            },
          },
        ]);
        break;
      }
    }
  }

  return contents;
}

function appendParts(
  contents: GeminiContent[],
  role: "user" | "model",
  parts: GeminiPart[],
): void {
  if (parts.length === 0) return;

  // Consecutive parts from the same role form one turn. This merges parallel
  // tool results instead of sending a run of one-part user messages.
  const previous = contents[contents.length - 1];
  if (previous !== undefined && previous.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
}

function parseResponse(data: unknown, signatures: Map<string, string>): ModelResponse {
  if (!isRecord(data)) {
    throw new ProviderResponseError(ERROR_MESSAGES.gemini.nonObjectResponse);
  }

  const candidate = firstCandidate(data);
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const part of candidateParts(candidate)) {
    if (!isRecord(part) || part.thought === true) continue;
    if (typeof part.text === "string") textParts.push(part.text);

    const toolCall = readToolCall(part, signatures);
    if (toolCall !== undefined) toolCalls.push(toolCall);
  }

  const text = textParts.join("");
  if (text.length === 0 && toolCalls.length === 0) throw emptyResponseError(candidate);

  return omitUndefined({ text, toolCalls, usage: readUsage(data) });
}

function firstCandidate(data: Record<string, unknown>): Record<string, unknown> {
  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const blockReason =
      isRecord(data.promptFeedback) && typeof data.promptFeedback.blockReason === "string"
        ? data.promptFeedback.blockReason
        : undefined;
    throw new ProviderResponseError(
      ERROR_MESSAGES.gemini.noCandidates(blockReason),
    );
  }

  const candidate = candidates[0];
  if (!isRecord(candidate)) {
    throw new ProviderResponseError(ERROR_MESSAGES.gemini.malformedCandidate);
  }
  return candidate;
}

function candidateParts(candidate: Record<string, unknown>): unknown[] {
  const content = candidate.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return [];
  return content.parts;
}

function readToolCall(
  part: Record<string, unknown>,
  signatures: Map<string, string>,
): ToolCall | undefined {
  const call = part.functionCall;
  if (!isRecord(call)) return undefined;

  if (typeof call.name !== "string" || call.name.length === 0) {
    throw new ProviderResponseError(
      ERROR_MESSAGES.gemini.functionCallMissingName,
    );
  }

  const args = call.args === undefined ? {} : call.args;
  if (!isRecord(args)) {
    throw new ProviderResponseError(
      ERROR_MESSAGES.gemini.functionCallArgumentsNotObject(call.name),
    );
  }

  const id =
    typeof call.id === "string" && call.id.length > 0
      ? call.id
      : `gemini_${crypto.randomUUID()}`;

  if (typeof part.thoughtSignature === "string") {
    signatures.set(id, part.thoughtSignature);
  }

  return { id, name: call.name, arguments: { ...args } };
}

function readUsage(data: Record<string, unknown>): TokenUsage | undefined {
  const metadata = data.usageMetadata;
  if (
    !isRecord(metadata) ||
    typeof metadata.promptTokenCount !== "number" ||
    typeof metadata.candidatesTokenCount !== "number"
  ) {
    return undefined;
  }

  const thoughts =
    typeof metadata.thoughtsTokenCount === "number" ? metadata.thoughtsTokenCount : 0;
  const toolUsePrompt =
    typeof metadata.toolUsePromptTokenCount === "number"
      ? metadata.toolUsePromptTokenCount
      : 0;

  return {
    inputTokens: metadata.promptTokenCount + toolUsePrompt,
    outputTokens: metadata.candidatesTokenCount + thoughts,
  };
}

function emptyResponseError(candidate: Record<string, unknown>): Error {
  const reason = typeof candidate.finishReason === "string" ? candidate.finishReason : "unknown";
  return new ProviderResponseError(ERROR_MESSAGES.gemini.emptyResponse(reason));
}

async function describeHttpError(response: Response): Promise<string> {
  return ERROR_MESSAGES.gemini.requestFailed(
    response.status,
    response.statusText,
    await response.text(),
  );
}
