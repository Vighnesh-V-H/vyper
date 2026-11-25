import { SandboxFailure } from "../errors";
import type {
  NormalizedSandboxRequest,
  SandboxAuditRecord,
  SandboxPolicyDecision,
  SandboxFailureCode,
  Grant,
  SandboxedToolExecutor as SandboxedToolExecutorContract,
  SandboxedToolExecutorDeps,
  SandboxedToolOutcome,
} from "../types/sandbox";
import type { NormalizationContext, SandboxExecutionResult } from "../types/sandbox";
import type { ToolExecutionRequest } from "../types/tools";

/** Hashes the immutable identity and permission scope of a persisted grant. */
export async function hashGrantIntegrity(
  grant: Pick<Grant, "sessionId" | "expiresAt" | "scope">,
): Promise<string> {
  const payload = JSON.stringify({
    sessionId: grant.sessionId,
    expiresAt: grant.expiresAt,
    scope: grant.scope,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Coordinates normalization, policy, approval, compilation, and backend execution. */
export class SandboxExecutor implements SandboxedToolExecutorContract {
  constructor(private readonly deps: SandboxedToolExecutorDeps) {}

  async execute(
    input: ToolExecutionRequest,
    context: NormalizationContext,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SandboxedToolOutcome> {
    const requestId = input.callId;
    let request: NormalizedSandboxRequest | undefined;
    let decision: SandboxPolicyDecision | undefined;
    let result: SandboxExecutionResult | undefined;

    try {
      const normalizedRequest = await this.stage("normalization-failed", () =>
        this.deps.normalizer.normalize(input, context)
      );
      if (
        normalizedRequest.requestId !== input.callId ||
        normalizedRequest.sessionId !== context.sessionId
      ) {
        throw new SandboxFailure(
          "normalization-failed",
          "Normalized sandbox request identity does not match the caller.",
        );
      }
      request = normalizedRequest;
      const normalized = normalizedRequest;
      if (options.signal?.aborted) {
        return this.failure(requestId, "cancelled", "Sandbox execution was cancelled.");
      }

      const policy = await this.stage("policy-error", () => this.deps.policyStore.load(context));
      const policyDecision = await this.stage("policy-error", () => this.deps.policyEngine.evaluate(normalized, {
        ...context,
        policy,
      }));
      decision = policyDecision;

      if (policyDecision.kind === "deny") {
        await this.audit(normalized, policyDecision);
        return {
          kind: "denied",
          requestId,
          reason: policyDecision.reason,
          ruleId: policyDecision.ruleId,
        };
      }

      let activeGrants = await this.stage("approval-failed", () =>
        this.deps.approvals.activeGrants(context.sessionId)
      );
      await this.validateGrants(activeGrants, context.sessionId);
      const profileName = policyDecision.profile;
      if (policyDecision.kind === "escalate") {
        const approval = await this.stage("approval-failed", async () => this.deps.approvals.request({
            request: normalized,
            reason: policyDecision.reason,
            profile: policyDecision.profile,
            scope: policyDecision.scope,
            scopeHash: await this.scopeHash(policyDecision.scope),
          }));
        if (approval.kind === "declined") {
          await this.audit(normalized, policyDecision);
          return {
            kind: "approval-declined",
            requestId,
            ...(approval.reason === undefined ? {} : { reason: approval.reason }),
          };
        }
        if (await this.scopeHash(approval.grant.scope) !== await this.scopeHash(policyDecision.scope)) {
          throw new SandboxFailure("approval-failed", "Approval grant scope does not match the requested scope.");
        }
        await this.validateGrant(approval.grant, context.sessionId);
        activeGrants = [...activeGrants, approval.grant];
      }

      const profile = await this.stage("profile-unknown", () => this.deps.profiles.get(profileName));
      if (!profile) {
        throw new SandboxFailure("profile-unknown", `Sandbox profile '${profileName}' was not found.`);
      }
      const spec = await this.stage("compile-failed", () =>
        this.deps.compiler.compile(profile, normalized, activeGrants)
      );
      const backend = this.deps.broker;
      const execution = normalized.execution;
      const executionResult = execution.kind === "command"
        ? await this.stage("execution-failed", () => backend.run(spec, {
            ...execution.command,
            environmentOverrides: this.allowedEnvironment(normalized, profile.environmentAllowlist),
          }, options.signal === undefined ? {} : { signal: options.signal }))
        : await this.stage("execution-failed", () => this.deps.trustedInProcess.run(
            normalized,
            options.signal === undefined ? {} : { signal: options.signal },
          ));
      result = executionResult;
      const output = await this.stage("output-filter-failed", () =>
        this.deps.outputFilter.filter(executionResult, normalized)
      );
      await this.audit(normalized, policyDecision, result);
      return { kind: "completed", requestId, result, output };
    } catch (error) {
      const code = error instanceof SandboxFailure ? error.failureCode : "internal";
      const message = error instanceof Error ? error.message : "Sandbox execution failed.";
      if (request) {
        try {
          await this.deps.audit.record(await this.auditRecord(
            request,
            decision ?? {
              kind: "deny",
              ruleId: "engine-error",
              source: "engine-error",
              reason: message,
            },
            result,
          ));
        } catch {
          if (this.deps.options.auditFailureMode === "fail-closed") {
            return this.failure(requestId, "audit-failed", "Sandbox audit recording failed.");
          }
        }
      }
      return this.failure(requestId, code, message);
    }
  }

  private allowedEnvironment(
    request: NormalizedSandboxRequest,
    allowlist: readonly string[],
  ): Readonly<Record<string, string>> {
    const overrides = request.execution.kind === "command"
      ? request.execution.command.environmentOverrides ?? {}
      : {};
    const allowed = new Set(allowlist);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (allowed.has(key)) result[key] = value;
    }
    return result;
  }

  private async scopeHash(scope: unknown): Promise<string> {
    return this.hash(JSON.stringify(scope));
  }

  private async validateGrants(
    grants: readonly Grant[],
    sessionId: string,
  ): Promise<void> {
    for (const grant of grants) {
      await this.validateGrant(grant, sessionId);
    }
  }

  private async validateGrant(grant: Grant, sessionId: string): Promise<void> {
    if (
      grant.sessionId !== sessionId ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      Date.parse(grant.expiresAt) <= Date.now()
    ) {
      throw new SandboxFailure("approval-failed", "Approval grant is expired or belongs to another session.");
    }
    if (grant.scopeHash !== await hashGrantIntegrity(grant)) {
      throw new SandboxFailure("approval-failed", "Approval grant integrity check failed.");
    }
  }

  private async stage<T>(
    code: SandboxFailureCode,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SandboxFailure) throw error;
      throw new SandboxFailure(code, error instanceof Error ? error.message : "Sandbox stage failed.", {
        cause: error,
      });
    }
  }

  private async hash(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private async audit(
    request: NormalizedSandboxRequest,
    decision: SandboxPolicyDecision,
    result?: SandboxExecutionResult,
  ): Promise<void> {
    try {
      await this.deps.audit.record(await this.auditRecord(request, decision, result));
    } catch (error) {
      if (this.deps.options.auditFailureMode === "fail-closed") {
        throw new SandboxFailure("audit-failed", "Sandbox audit recording failed.", { cause: error });
      }
    }
  }

  private async auditRecord(
    request: NormalizedSandboxRequest,
    decision: SandboxPolicyDecision,
    result?: SandboxExecutionResult,
  ): Promise<SandboxAuditRecord> {
    return {
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      requestHash: await this.hash(`${request.sessionId}\u0000${request.requestId}\u0000${request.toolName}\u0000${request.display}`),
      decision: decision.kind,
      ruleId: decision.ruleId,
      decisionSource: decision.source,
      ...(decision.kind === "deny" ? { denialReason: decision.reason } : {}),
      ...(decision.kind !== "deny" ? { profileName: decision.profile } : {}),
      ...(result === undefined ? {} : {
        backend: result.backend,
        exitCode: result.exitCode,
        terminationReason: result.terminationReason,
        violations: result.violations,
        durationMs: result.durationMs,
      }),
    };
  }

  private failure(
    requestId: string,
    code: SandboxFailureCode,
    message: string,
  ): SandboxedToolOutcome {
    return { kind: "failed", requestId, code, message };
  }
}
