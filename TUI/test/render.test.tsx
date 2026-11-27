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
    branch: "test-branch",
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
      expect(frame).toContain("A small terminal coding agent");
      expect(frame).toContain("test-branch");
      expect(frame).toContain("context —");
      expect(frame).toContain("test-model · idle");
      expect(frame).not.toContain("REGISTERED TOOLS");
      expect(frame).not.toContain("WHAT IS IN PLACE");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("shows, navigates, completes, and executes slash commands", async () => {
    let exited = false;
    const setup = await testRender(
      <App config={testConfig()} onExit={() => { exited = true; }} />,
      { width: 100, height: 30 },
    );

    try {
      await act(async () => {
        await setup.mockInput.typeText("/");
      });
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      expect(frame).toContain("/new");
      expect(frame).toContain("/clear");
      expect(frame).toContain("/exit");
      expect(frame).toContain("/quit");

      await act(() => setup.mockInput.pressArrow("down"));
      await act(() => setup.mockInput.pressArrow("down"));
      await act(() => setup.mockInput.pressTab());
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("/exit ");

      await act(() => {
        setup.mockInput.pressEnter();
      });
      expect(exited).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("executes the highlighted command on enter without tab completion", async () => {
    let exited = false;
    const setup = await testRender(
      <App config={testConfig()} onExit={() => { exited = true; }} />,
      { width: 100, height: 30 },
    );

    try {
      await act(async () => setup.mockInput.typeText("/"));
      await act(() => setup.mockInput.pressArrow("down"));
      await act(() => setup.mockInput.pressArrow("down"));
      await act(() => setup.mockInput.pressEnter());
      expect(exited).toBe(true);
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
