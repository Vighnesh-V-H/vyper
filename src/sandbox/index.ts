import { SandboxFailure } from "../errors";
import type {
  ApprovalOutcome,
  ApprovalRequest,
  Grant,
  NormalizedSandboxRequest,
  SandboxAuditRecord,
  SandboxExecutionMetadata,
  SandboxExecutionResult,
  SandboxFailureCode,
  SandboxPolicyDecision,
  SandboxedToolExecutor as SandboxedToolExecutorContract,
  SandboxedToolExecutorDeps,
  SandboxedToolOutcome,
} from "../types/sandbox";
import type { NormalizationContext } from "../types/sandbox";
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
    const signal = options.signal;
    let request: NormalizedSandboxRequest | undefined;
    let decision: SandboxPolicyDecision | undefined;
    let result: SandboxExecutionResult | undefined;
    let approvalRecord: SandboxAuditRecord["approval"] | undefined;

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
      if (signal?.aborted) {
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
        const scopeHash = await this.scopeHash(policyDecision.scope);
        const approvalRequest: ApprovalRequest = {
          request: normalized,
          reason: policyDecision.reason,
          profile: policyDecision.profile,
          scope: policyDecision.scope,
          scopeHash,
        };
        const approvalOutcome = await this.stage("approval-failed", () =>
          this.requestApproval(approvalRequest, signal)
        );
        if (approvalOutcome.kind === "declined") {
          await this.audit(normalized, policyDecision);
          return {
            kind: "approval-declined",
            requestId,
            ...(approvalOutcome.reason === undefined ? {} : { reason: approvalOutcome.reason }),
          };
        }
        if (await this.scopeHash(approvalOutcome.grant.scope) !== scopeHash) {
          throw new SandboxFailure("approval-failed", "Approval grant scope does not match the requested scope.");
        }
        activeGrants = [...activeGrants, approvalOutcome.grant];
        // Grants validated before the approval wait may have expired while waiting.
        await this.validateGrants(activeGrants, context.sessionId);
        approvalRecord = {
          grantId: approvalOutcome.grant.id,
          scopeHash: approvalOutcome.grant.scopeHash,
          approvedBy: approvalOutcome.grant.approvedBy,
        };
      }

      const profile = await this.stage("profile-unknown", () => this.deps.profiles.get(profileName));
      if (!profile) {
        throw new SandboxFailure("profile-unknown", `Sandbox profile '${profileName}' was not found.`);
      }
      const spec = await this.stage("compile-failed", () =>
        this.deps.compiler.compile(profile, normalized, activeGrants)
      );
      this.throwIfCancelled(signal);
      // Record the decision before any handler can change state. In fail-closed
      // mode this is the barrier that prevents unrecorded execution.
      await this.audit(normalized, policyDecision, undefined, approvalRecord);
      this.throwIfCancelled(signal);

      const backend = this.deps.broker;
      const execution = normalized.execution;
      const executionResult = execution.kind === "command"
        ? await this.stage("execution-failed", () => backend.run(spec, {
            ...execution.command,
            environmentOverrides: this.allowedEnvironment(normalized, spec.environmentAllowlist),
          }, signal === undefined ? {} : { signal }))
        : await this.stage("execution-failed", () => this.deps.trustedInProcess.run(
            normalized,
            signal === undefined ? {} : { signal },
          ));
      result = executionResult;
      const output = await this.stage("output-filter-failed", () =>
        this.deps.outputFilter.filter(executionResult, normalized)
      );
      const metadata = this.executionMetadata(executionResult);
      await this.audit(normalized, policyDecision, metadata, approvalRecord);
      return { kind: "completed", requestId, metadata, output };
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
            result === undefined ? undefined : this.executionMetadata(result),
            approvalRecord,
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

  private async requestApproval(
    approval: ApprovalRequest,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalOutcome> {
    if (signal?.aborted) {
      throw new SandboxFailure("cancelled", "Sandbox execution was cancelled before approval.");
    }
    const pending = this.deps.approvals.request(
      approval,
      signal === undefined ? {} : { signal },
    );
    return this.cancellable(
      pending,
      signal,
      "Sandbox execution was cancelled while awaiting approval.",
    );
  }

  /** Settles with `operation` unless the signal aborts first. */
  private async cancellable<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    message: string,
  ): Promise<T> {
    if (signal === undefined) return operation;
    if (signal.aborted) {
      // Keep a late rejection from becoming an unhandled promise rejection.
      operation.catch(() => {});
      throw new SandboxFailure("cancelled", message);
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        reject(new SandboxFailure("cancelled", message));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            reject(new SandboxFailure("cancelled", message));
          } else {
            resolve(value);
          }
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            reject(new SandboxFailure("cancelled", message));
          } else {
            reject(error);
          }
        },
      );
    });
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new SandboxFailure("cancelled", "Sandbox execution was cancelled.");
    }
  }

  /** Drops raw streams so only the filtered output can leave the sandbox. */
  private executionMetadata(result: SandboxExecutionResult): SandboxExecutionMetadata {
    const { stdout: _stdout, stderr: _stderr, ...metadata } = result;
    return metadata;
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
    result?: SandboxExecutionMetadata,
    approval?: SandboxAuditRecord["approval"],
  ): Promise<void> {
    try {
      await this.deps.audit.record(await this.auditRecord(request, decision, result, approval));
    } catch (error) {
      if (this.deps.options.auditFailureMode === "fail-closed") {
        throw new SandboxFailure("audit-failed", "Sandbox audit recording failed.", { cause: error });
      }
    }
  }

  private async auditRecord(
    request: NormalizedSandboxRequest,
    decision: SandboxPolicyDecision,
    result?: SandboxExecutionMetadata,
    approval?: SandboxAuditRecord["approval"],
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
      ...(approval === undefined ? {} : { approval }),
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
