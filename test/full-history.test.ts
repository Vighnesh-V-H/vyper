import { describe, expect, test } from "bun:test";
import { FullHistoryContext } from "../src/context/full-history";
import type { Message } from "../src/types/message";

describe("FullHistoryContext", () => {
  test("keeps every prior message even beyond the old window limits", async () => {
    const messages: Message[] = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push({ role: "user", content: `prompt ${index} ${"x".repeat(600)}` });
      messages.push({ role: "assistant", content: `reply ${index} ${"y".repeat(600)}` });
    }

    const prepared = await new FullHistoryContext().prepare({ messages });
    expect(prepared.compacted).toBe(false);
    expect(prepared.messages).toEqual(messages);
    expect(prepared.messages).toHaveLength(120);
  });
});
