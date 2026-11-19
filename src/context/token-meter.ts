import type { TokenMeter, TokenUsage } from "../types/context";
import type { Message } from "../types/message";

function estimateChars(message: Message): number {
  if (message.role === "assistant") {
    let chars = message.content?.length ?? 0;
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length + JSON.stringify(call.arguments).length;
    }
    return chars;
  }

  return (
    message.content.length +
    (message.role === "tool" ? message.toolCallId.length : 0)
  );
}

export class CharTokenMeter implements TokenMeter {
  private _lastInputTokens: number | undefined;

  get lastInputTokens(): number | undefined {
    return this._lastInputTokens;
  }

  estimate(messages: Message[]): number {
    let chars = 0;
    for (const message of messages) chars += estimateChars(message);
    return Math.ceil(chars / 4);
  }

  measureText(text: string): number {
    return Math.ceil(text.length / 4);
  }

  record(usage: TokenUsage): void {
    this._lastInputTokens = usage.inputTokens;
  }
}
