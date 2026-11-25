import { describe, expect, test } from "bun:test";
import { asToolCallId } from "../src/types/ids";
import { SandboxExecutor } from "../src/sandbox";
import type {
  CanonicalPath,
  NormalizedSandboxRequest,
  SandboxedToolExecutorDeps,
} from "../src/types/sandbox";

const cwd = "/workspace" as CanonicalPath;

function request(): NormalizedSandboxRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    toolName: "shell",
    original: { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
    capabilities: {},
    execution: {
      kind: "command",
      command: { executable: "echo", args: ["hello"] },
    },
    display: "echo hello",
  };
}

describe("SandboxExecutor", () => {
  test("denies a request before profile compilation or backend execution", async () => {
    const records: unknown[] = [];
    const deps: SandboxedToolExecutorDeps = {
      normalizer: { normalize: async () => request() },
      policyStore: { load: async () => ({ layers: [] }) },
      policyEngine: {
        evaluate: () => ({
          kind: "deny",
          ruleId: "deny-shell",
          source: "project",
          reason: "shell commands are disabled",
        }),
      },
      profiles: { get: async () => undefined },
      approvals: {
        request: async () => ({ kind: "declined" }),
        activeGrants: async () => [],
      },
      compiler: { compile: async () => { throw new Error("must not compile"); } },
      broker: { run: async () => { throw new Error("must not run"); } },
      outputFilter: { filter: () => { throw new Error("must not filter"); } },
      audit: { record: async (record) => { records.push(record); } },
      options: { auditFailureMode: "fail-closed", escalateOnViolation: false },
    };

    const executor = new SandboxExecutor(deps);
    const outcome = await executor.execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome).toEqual({
      kind: "denied",
      requestId: asToolCallId("call-1"),
      reason: "shell commands are disabled",
      ruleId: "deny-shell",
    });
    expect(records).toHaveLength(1);
  });
});
