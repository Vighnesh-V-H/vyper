import { describe, expect, test } from "bun:test";
import { asToolCallId } from "../src/types/ids";
import { SandboxExecutor } from "../src/sandbox";
import type {
  CanonicalPath,
  NormalizedSandboxRequest,
  SandboxExecutionResult,
  SandboxProfile,
  SandboxSpec,
  SandboxedToolExecutorDeps,
} from "../src/types/sandbox";

const cwd = "/workspace" as CanonicalPath;

function request(): NormalizedSandboxRequest {
  return {
    requestId: "call-1",
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

const profile: SandboxProfile = {
  name: "trusted",
  isolation: "os",
  readOnlyPaths: [],
  writablePaths: [],
  deniedPaths: [],
  network: { kind: "none" },
  environmentAllowlist: [],
  limits: {},
};

const spec: SandboxSpec = {
  isolation: "os",
  readOnlyPaths: [],
  writablePaths: [],
  deniedPaths: [],
  network: { kind: "none" },
  environmentAllowlist: [],
  cwd,
  limits: { wallTimeMs: 1, memoryBytes: 1, processCount: 1, outputBytes: 1 },
};

const executionResult: SandboxExecutionResult = {
  stdout: "hello",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: 0,
  terminationReason: "exit",
  timedOut: false,
  durationMs: 1,
  backend: "test",
  violations: [],
};

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
      trustedInProcess: { run: async () => { throw new Error("must not run"); } },
      outputFilter: { filter: () => { throw new Error("must not filter"); } },
      audit: { record: async (record) => { records.push(record); } },
      options: { auditFailureMode: "fail-closed" },
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

  test("executes trusted in-process requests only through the supplied executor", async () => {
    const trustedRequest = {
      ...request(),
      execution: { kind: "trusted-in-process" as const, reason: "application handler" },
    };
    let trustedCalls = 0;
    let brokerCalls = 0;
    const deps: SandboxedToolExecutorDeps = {
      normalizer: { normalize: async () => trustedRequest },
      policyStore: { load: async () => ({ layers: [] }) },
      policyEngine: {
        evaluate: () => ({ kind: "allow", ruleId: "allow-tool", source: "project", profile: "trusted" }),
      },
      profiles: { get: async () => profile },
      approvals: { request: async () => ({ kind: "declined" }), activeGrants: async () => [] },
      compiler: { compile: async () => spec },
      broker: { run: async () => { brokerCalls += 1; return executionResult; } },
      trustedInProcess: { run: async () => { trustedCalls += 1; return executionResult; } },
      outputFilter: { filter: () => ({ trust: "untrusted", text: "hello", truncated: false, redactionCount: 0 }) },
      audit: { record: async () => {} },
      options: { auditFailureMode: "fail-closed" },
    };

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome.kind).toBe("completed");
    expect(trustedCalls).toBe(1);
    expect(brokerCalls).toBe(0);
  });

  test("retains the allow decision and result when output filtering fails", async () => {
    const records: unknown[] = [];
    const deps: SandboxedToolExecutorDeps = {
      normalizer: { normalize: async () => request() },
      policyStore: { load: async () => ({ layers: [] }) },
      policyEngine: {
        evaluate: () => ({ kind: "allow", ruleId: "allow-shell", source: "project", profile: "trusted" }),
      },
      profiles: { get: async () => profile },
      approvals: { request: async () => ({ kind: "declined" }), activeGrants: async () => [] },
      compiler: { compile: async () => spec },
      broker: { run: async () => executionResult },
      trustedInProcess: { run: async () => executionResult },
      outputFilter: { filter: () => { throw new Error("filter failed"); } },
      audit: {
        record: async (record) => {
          records.push(record);
        },
      },
      options: { auditFailureMode: "best-effort" },
    };

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome).toMatchObject({ kind: "failed", code: "output-filter-failed", message: "filter failed" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decision: "allow",
      ruleId: "allow-shell",
      backend: "test",
      exitCode: 0,
    });
  });
});
