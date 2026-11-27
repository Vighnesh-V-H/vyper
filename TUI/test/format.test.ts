import { describe, expect, test } from "bun:test";
import {
  displayPath,
  formatDuration,
  formatTokenCount,
  formatUsage,
  preview,
  shortId,
  stripAnsi,
} from "../src/format";

describe("terminal formatting", () => {
  test("strips ANSI sequences and normalizes carriage returns", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m\r\nnext")).toBe("red\nnext");
  });

  test("flattens and bounds tool output", () => {
    expect(preview("line one\n\n  line two", 40)).toBe("line one line two");
    const bounded = preview("x".repeat(50), 10);
    expect(bounded).toHaveLength(10);
    expect(bounded.endsWith("…")).toBe(true);
  });

  test("formats durations, tokens, and usage", () => {
    expect(formatDuration(42.4)).toBe("42ms");
    expect(formatDuration(1_240)).toBe("1.2s");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_200)).toBe("1.2k");
    expect(formatTokenCount(2_000_000)).toBe("2m");
    expect(formatUsage(1_200, 300)).toBe("1.2k in · 300 out");
  });

  test("shortens home paths and long ids", () => {
    expect(displayPath("/home/ada/project", "/home/ada")).toBe("~/project");
    expect(displayPath("/home/ada", "/home/ada")).toBe("~");
    expect(displayPath("/work/project", "/home/ada")).toBe("/work/project");
    expect(shortId("abcdef", 5)).toBe("…cdef");
    expect(shortId("abc", 5)).toBe("abc");
  });
});
