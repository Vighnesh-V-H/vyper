import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveSessionDirectory } from "../src/cli";

describe("resolveSessionDirectory", () => {
  test("uses the full resolved project path as a stable isolation key", () => {
    const projectPath = resolve("/work/acme");
    const key = createHash("sha256").update(projectPath).digest("hex");
    expect(resolveSessionDirectory(projectPath, undefined)).toBe(
      resolve(homedir(), ".pi", "agent", "sessions", key),
    );
  });

  test("isolates projects with the same directory name", () => {
    const first = resolveSessionDirectory("/work/client-a/api", undefined);
    const second = resolveSessionDirectory("/work/client-b/api", undefined);
    expect(first).not.toBe(second);
  });

  test("keeps an explicit relative override project-relative", () => {
    expect(resolveSessionDirectory("/work/acme", "data/sessions")).toBe(
      resolve("/work/acme", "data/sessions"),
    );
  });

  test("trims whitespace-only overrides and uses the project-path key", () => {
    const projectPath = resolve("/work/acme");
    const key = createHash("sha256").update(projectPath).digest("hex");
    expect(resolveSessionDirectory(projectPath, "  ")).toBe(
      resolve(homedir(), ".pi", "agent", "sessions", key),
    );
  });
});
