import type { Message, TokenMeter, TokenUsage } from "../types";

export class CharTokenMeter implements TokenMeter {
  private _lastInputTokens: number | undefined;

  get lastInputTokens(): number | undefined {
    return this._lastInputTokens;
  }

  estimate(messages: Message[]): number {
    let chars = 0;
    for (const message of messages) {
      if (message.role === "assistant") {
        chars += message.content?.length ?? 0;
        for (const call of message.toolCalls ?? []) {
          chars += call.name.length + JSON.stringify(call.arguments).length;
        }
      } else {
        chars += message.content.length;
        if (message.role === "tool") chars += message.toolCallId.length;
      }
    }
    return Math.ceil(chars / 4);
  }

  measureText(text: string): number {
    return Math.ceil(text.length / 4);
  }

  record(usage: TokenUsage): void {
    this._lastInputTokens = usage.inputTokens;
  }
}
