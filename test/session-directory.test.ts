import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveSessionDirectory } from "../src/cli";

describe("resolveSessionDirectory", () => {
  test("uses the per-user Pi session directory scoped by project name", () => {
    expect(resolveSessionDirectory("/work/acme", undefined)).toBe(
      resolve(homedir(), ".pi", "agent", "sessions", "acme"),
    );
  });

  test("keeps an explicit relative override project-relative", () => {
    expect(resolveSessionDirectory("/work/acme", "data/sessions")).toBe(
      resolve("/work/acme", "data/sessions"),
    );
  });

  test("trims whitespace-only overrides and uses the default", () => {
    expect(resolveSessionDirectory("/work/acme", "  ")).toBe(
      resolve(homedir(), ".pi", "agent", "sessions", "acme"),
    );
  });
});
