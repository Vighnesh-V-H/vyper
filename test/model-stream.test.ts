import { describe, expect, test } from "bun:test";
import { collectModelStream } from "../src/agent/model-stream";
import { asToolCallId } from "../src/types/ids";
import { ModelStreamChunkType } from "../src/types/model";

const call = {
  id: asToolCallId("call-1"),
  name: "tool",
  arguments: {},
};

describe("collectModelStream", () => {
  test("closes the iterator after a chunk accumulation error", async () => {
    let cleanedUp = false;
    async function* chunks() {
      try {
        yield { type: ModelStreamChunkType.ToolCallDone, toolCall: call } as const;
        yield { type: ModelStreamChunkType.ToolCallDone, toolCall: call } as const;
      } finally {
        cleanedUp = true;
      }
    }

    await expect(
      collectModelStream(chunks(), new AbortController().signal),
    ).rejects.toThrow(/duplicate completed tool call/);
    expect(cleanedUp).toBe(true);
  });
});
