import { describe, expect, test } from "bun:test";
import { read } from "../src/tools/builtin/read";
import { clockTool } from "../src/tools/builtin/clock";
import { executeTool } from "../src/tools/executor";
import { ToolRegistry } from "../src/tools/registry";
import { validateToolDefinition } from "../src/tools/validation";
import { ToolExecutionErrorKind } from "../src/types";
import { asToolCallId } from "../src/types/ids";

const catalog = new ToolRegistry([clockTool, read]);
const cwd = process.cwd();
const signal = new AbortController().signal;

describe("tool argument validation", () => {
  test("accepts valid read arguments and omits absent optional fields", () => {
    expect(read.parse({ path: "package.json" })).toEqual({ path: "package.json" });
    expect(read.parse({ path: "src", offset: 2, limit: 5 })).toEqual({
      path: "src",
      offset: 2,
      limit: 5,
    });
  });

  test("rejects missing, blank, and non-positive arguments", () => {
    expect(() => read.parse({})).toThrow();
    expect(() => read.parse({ path: "  " })).toThrow();
    expect(() => read.parse({ path: "src", offset: 0 })).toThrow();
    expect(() => read.parse({ path: "src", limit: 1.5 })).toThrow();
  });
});

describe("tool execution", () => {
  test("executes a valid tool", async () => {
    const result = await executeTool(catalog, {
      callId: asToolCallId("clock-1"),
      name: "clock",
      arguments: {},
      cwd,
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("reports unknown tools", async () => {
    const result = await executeTool(catalog, {
      callId: asToolCallId("missing-1"),
      name: "missing",
      arguments: {},
      cwd,
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe(ToolExecutionErrorKind.UnknownTool);
  });

  test("reports invalid arguments", async () => {
    const result = await executeTool(catalog, {
      callId: asToolCallId("read-1"),
      name: "read",
      arguments: {},
      cwd,
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe(ToolExecutionErrorKind.InvalidArguments);
  });

  test("rejects invalid nested parameter schemas", () => {
    expect(() =>
      validateToolDefinition({
        name: "invalid",
        description: "Invalid nested schema",
        parameters: {
          type: "object",
          properties: {
            value: { type: "not-a-json-schema-type" },
          },
        },
        parse: (input: unknown) => input,
        execute: () => undefined,
        render: () => "",
      }),
    ).toThrow();
  });

  test("rejects paths outside the working directory", async () => {
    const result = await executeTool(catalog, {
      callId: asToolCallId("read-2"),
      name: "read",
      arguments: { path: "../outside.txt" },
      cwd,
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe(ToolExecutionErrorKind.Execution);
    expect(result.content).toContain("Path must stay inside the working directory");
  });
});
