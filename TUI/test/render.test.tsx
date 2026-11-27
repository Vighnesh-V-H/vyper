import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../src/app";
import type { ToolCatalog } from "../../src/types/tools";
import type { TuiConfig } from "../src/types";

const tools: ToolCatalog = {
  get: () => undefined,
  list: () => [],
};

function testConfig(): TuiConfig {
  return {
    cwd: process.cwd(),
    model: "test-model",
    apiKey: undefined,
    instructions: "test instructions",
    maxSteps: 4,
    toolConcurrency: 1,
    sessionDirectory: "/tmp/vyper-sessions",
    tools,
    toolSummaries: [
      {
        name: "read",
        description: "Read a file from the working directory.",
        kind: "builtin",
      },
    ],
    runtime: "Bun test",
  };
}

describe("App", () => {
  test("renders the shell and offline state", async () => {
    const setup = await testRender(
      <App config={testConfig()} onExit={() => {}} />,
      { width: 100, height: 30 },
    );

    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("VYPER");
      expect(frame).toContain("terminal coding agent");
      expect(frame).toContain("GOOGLE_GENERATIVE_AI_API_KEY is not set");
      expect(frame).toContain("chat");
      expect(frame).toContain("tools 1");
      expect(frame).toContain("about");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("switches views with tab", async () => {
    const setup = await testRender(
      <App config={testConfig()} onExit={() => {}} />,
      { width: 100, height: 36 },
    );

    try {
      await act(() => {
        setup.mockInput.pressTab();
      });
      await setup.renderOnce();
      const toolsFrame = setup.captureCharFrame();
      expect(toolsFrame).toContain("REGISTERED TOOLS");
      expect(toolsFrame).toContain("read");
      expect(toolsFrame).toContain("FullHistoryContext");

      await act(() => {
        setup.mockInput.pressTab();
      });
      await setup.renderOnce();
      const aboutFrame = setup.captureCharFrame();
      expect(aboutFrame).toContain("WHAT IS IN PLACE");
      expect(aboutFrame).toContain("Provider-neutral agent loop");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("surfaces the missing-key error when a prompt is submitted", async () => {
    const setup = await testRender(
      <App config={testConfig()} onExit={() => {}} />,
      { width: 100, height: 30 },
    );

    try {
      await act(async () => {
        await setup.mockInput.typeText("explain the loop");
        setup.mockInput.pressEnter();
      });
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Add it to .env and restart.");
      expect(frame).toContain("explain the loop");
      expect(frame).not.toContain("A small terminal coding agent");
    } finally {
      setup.renderer.destroy();
    }
  });
});
