import { describe, expect, test } from "bun:test";
import { asToolCallId } from "../src/types/ids";
import { hashGrantIntegrity, SandboxExecutor } from "../src/sandbox";
import type {
  ApprovalOutcome,
  CanonicalPath,
  Grant,
  NormalizedSandboxRequest,
  SandboxAuditRecord,
  SandboxExecutionResult,
  SandboxProfile,
  SandboxSpec,
  SandboxedToolExecutorDeps,
  ScopeDelta,
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

function scope(overrides: Partial<ScopeDelta> = {}): ScopeDelta {
  return {
    addReadPaths: [],
    addWritePaths: [],
    addNetworkHosts: [],
    addEnvironmentVariables: [],
    allowSubprocess: false,
    ...overrides,
  };
}

async function grant(overrides: Partial<Grant> = {}): Promise<Grant> {
  const base = {
    id: "grant-1",
    sessionId: "session-1",
    scope: scope(),
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    approvedBy: "reviewer",
    ...overrides,
  };
  return { ...base, scopeHash: await hashGrantIntegrity(base) };
}

function createDeps(
  overrides: Partial<SandboxedToolExecutorDeps> = {},
): SandboxedToolExecutorDeps {
  return {
    normalizer: { normalize: async () => request() },
    policyStore: { load: async () => ({ layers: [] }) },
    policyEngine: {
      evaluate: () => ({
        kind: "allow",
        ruleId: "allow-shell",
        source: "project",
        profile: "trusted",
      }),
    },
    profiles: { get: async () => profile },
    approvals: {
      request: async () => ({ kind: "declined" }),
      activeGrants: async () => [],
    },
    compiler: { compile: async () => spec },
    broker: { run: async () => executionResult },
    trustedInProcess: { run: async () => executionResult },
    outputFilter: {
      filter: () => ({ trust: "untrusted", text: "hello", truncated: false, redactionCount: 0 }),
    },
    audit: { record: async () => {} },
    options: { auditFailureMode: "best-effort" },
    ...overrides,
  };
}

describe("SandboxExecutor", () => {
  test("grant integrity hashes bind session, expiration, and scope", async () => {
    const grant = {
      sessionId: "session-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scope: {
        addReadPaths: [],
        addWritePaths: [],
        addNetworkHosts: [],
        addEnvironmentVariables: [],
        allowSubprocess: false,
      },
    };
    const hash = await hashGrantIntegrity(grant);
    expect(await hashGrantIntegrity(grant)).toBe(hash);
    expect(await hashGrantIntegrity({ ...grant, sessionId: "session-2" })).not.toBe(hash);
    expect(await hashGrantIntegrity({ ...grant, expiresAt: "2031-01-01T00:00:00.000Z" })).not.toBe(hash);
    expect(await hashGrantIntegrity({
      ...grant,
      scope: { ...grant.scope, allowSubprocess: true },
    })).not.toBe(hash);
  });

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
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ decision: "allow", ruleId: "allow-shell" });
    expect(records[0]).not.toHaveProperty("backend");
    expect(records[1]).toMatchObject({
      decision: "allow",
      ruleId: "allow-shell",
      backend: "test",
      exitCode: 0,
    });
  });

  test("passes environment variables allowed by the compiled spec", async () => {
    const envRequest: NormalizedSandboxRequest = {
      ...request(),
      execution: {
        kind: "command",
        command: {
          executable: "echo",
          args: ["hello"],
          environmentOverrides: { APPROVED: "yes", BASE: "base", DENIED: "no" },
        },
      },
    };
    let overrides: Readonly<Record<string, string>> | undefined;
    const deps = createDeps({
      normalizer: { normalize: async () => envRequest },
      compiler: {
        compile: async () => ({ ...spec, environmentAllowlist: ["BASE", "APPROVED"] }),
      },
      broker: {
        run: async (_spec, command) => {
          overrides = command.environmentOverrides;
          return executionResult;
        },
      },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome.kind).toBe("completed");
    expect(overrides).toEqual({ APPROVED: "yes", BASE: "base" });
  });

  test("records the decision before execution and the result afterward", async () => {
    const records: SandboxAuditRecord[] = [];
    let recordsAtExecution = 0;
    const deps = createDeps({
      broker: {
        run: async () => {
          recordsAtExecution = records.length;
          return executionResult;
        },
      },
      audit: { record: async (record) => { records.push(record); } },
      options: { auditFailureMode: "fail-closed" },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome.kind).toBe("completed");
    expect(recordsAtExecution).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[0]).not.toHaveProperty("backend");
    expect(records[1]).toMatchObject({ backend: "test", exitCode: 0 });
  });

  test("does not execute when the pre-execution audit cannot be recorded", async () => {
    let brokerCalls = 0;
    const deps = createDeps({
      broker: { run: async () => { brokerCalls += 1; return executionResult; } },
      audit: { record: async () => { throw new Error("audit sink unavailable"); } },
      options: { auditFailureMode: "fail-closed" },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome).toMatchObject({ kind: "failed", code: "audit-failed" });
    expect(brokerCalls).toBe(0);
  });

  test("revalidates every grant after the approval wait", async () => {
    const approvedScope = scope();
    const existingGrant = await grant({ id: "existing" });
    const approvedGrant = await grant({
      id: "approved",
      scope: approvedScope,
      approvedBy: "alice",
    });
    let compileCalls = 0;
    let brokerCalls = 0;
    const deps = createDeps({
      policyEngine: {
        evaluate: () => ({
          kind: "escalate",
          ruleId: "escalate-shell",
          source: "project",
          profile: "trusted",
          reason: "approval required",
          scope: approvedScope,
        }),
      },
      approvals: {
        request: async () => {
          // Simulate the existing grant expiring while the prompt is open.
          Object.assign(existingGrant, { expiresAt: "2020-01-01T00:00:00.000Z" });
          return { kind: "approved", grant: approvedGrant };
        },
        activeGrants: async () => [existingGrant],
      },
      compiler: { compile: async () => { compileCalls += 1; return spec; } },
      broker: { run: async () => { brokerCalls += 1; return executionResult; } },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome).toMatchObject({ kind: "failed", code: "approval-failed" });
    expect(compileCalls).toBe(0);
    expect(brokerCalls).toBe(0);
  });

  test("cancels an approval wait and notifies the provider", async () => {
    const controller = new AbortController();
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let providerSignal: AbortSignal | undefined;
    let compileCalls = 0;
    const deps = createDeps({
      policyEngine: {
        evaluate: () => ({
          kind: "escalate",
          ruleId: "escalate-shell",
          source: "project",
          profile: "trusted",
          reason: "approval required",
          scope: scope(),
        }),
      },
      approvals: {
        request: (_approval, options) => {
          providerSignal = options?.signal;
          notifyStarted();
          return new Promise<ApprovalOutcome>(() => {});
        },
        activeGrants: async () => [],
      },
      compiler: { compile: async () => { compileCalls += 1; return spec; } },
    });

    const execution = new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
      { signal: controller.signal },
    );
    await started;
    expect(providerSignal).toBe(controller.signal);
    controller.abort();

    expect(await execution).toMatchObject({ kind: "failed", code: "cancelled" });
    expect(compileCalls).toBe(0);
  });

  test("checks cancellation again before starting the backend", async () => {
    const controller = new AbortController();
    let brokerCalls = 0;
    const deps = createDeps({
      compiler: {
        compile: async () => {
          controller.abort();
          return spec;
        },
      },
      broker: { run: async () => { brokerCalls += 1; return executionResult; } },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
      { signal: controller.signal },
    );

    expect(outcome).toMatchObject({ kind: "failed", code: "cancelled" });
    expect(brokerCalls).toBe(0);
  });

  test("exposes execution metadata without raw streams", async () => {
    const deps = createDeps({
      broker: {
        run: async () => ({
          ...executionResult,
          stdout: "secret stdout",
          stderr: "secret stderr",
        }),
      },
      outputFilter: {
        filter: () => ({ trust: "untrusted", text: "redacted", truncated: false, redactionCount: 2 }),
      },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.text).toBe("redacted");
    expect(outcome.metadata).not.toHaveProperty("stdout");
    expect(outcome.metadata).not.toHaveProperty("stderr");
    expect(outcome.metadata).toMatchObject({ backend: "test", exitCode: 0 });
  });

  test("records approval identity on audit entries", async () => {
    const approvedScope = scope({ addEnvironmentVariables: ["APPROVED"] });
    const approvedGrant = await grant({
      id: "grant-42",
      scope: approvedScope,
      approvedBy: "alice",
    });
    const records: SandboxAuditRecord[] = [];
    const deps = createDeps({
      policyEngine: {
        evaluate: () => ({
          kind: "escalate",
          ruleId: "escalate-shell",
          source: "project",
          profile: "trusted",
          reason: "approval required",
          scope: approvedScope,
        }),
      },
      approvals: {
        request: async () => ({ kind: "approved", grant: approvedGrant }),
        activeGrants: async () => [],
      },
      audit: { record: async (record) => { records.push(record); } },
      options: { auditFailureMode: "fail-closed" },
    });

    const outcome = await new SandboxExecutor(deps).execute(
      { callId: asToolCallId("call-1"), name: "shell", arguments: {} },
      { cwd, sessionId: "session-1" },
    );

    expect(outcome.kind).toBe("completed");
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.approval).toEqual({
        grantId: "grant-42",
        scopeHash: approvedGrant.scopeHash,
        approvedBy: "alice",
      });
    }
  });
});
