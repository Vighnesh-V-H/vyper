import type { ToolExecutionRequest } from "./tools";

declare const canonicalPathBrand: unique symbol;

/** An absolute, symlink-resolved path prepared for sandbox bind-mounting. */
export type CanonicalPath = string & {
  readonly [canonicalPathBrand]: true;
};

export interface PathCanonicalizer {
  /**
   * Expand supported globs, resolve symlinks, and reject results outside `base`.
   * Implementations must document behavior for missing paths and must not treat
   * string-prefix checks as containment checks.
   */
  canonicalize(
    pattern: string,
    base: CanonicalPath,
  ): Promise<readonly CanonicalPath[]>;
}

export interface HostRule {
  /** Exact hostname or `*.suffix`; wildcard matches subdomains, not the suffix itself. */
  readonly host: string;
  readonly ports: readonly number[];
}

export interface CredentialInjectionRule {
  readonly host: string;
  readonly secretId: string;
  /** Must be a valid HTTP token; values containing CR/LF are forbidden. */
  readonly header: string;
  readonly scheme?: string;
}

export type SandboxNetworkPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "proxy";
      readonly allowedHosts: readonly HostRule[];
      readonly allowLoopback: boolean;
      readonly allowIpLiterals: boolean;
      readonly credentialRules: readonly CredentialInjectionRule[];
    };

/** Secrets are provided only to the trusted proxy, never to the sandbox process. */
export interface SecretProvider {
  get(secretId: string, context: { readonly sessionId: string }): Promise<string>;
}

export interface SandboxResourceLimits {
  readonly wallTimeMs: number;
  readonly memoryBytes: number;
  readonly processCount: number;
  readonly outputBytes: number;
  readonly cpuTimeMs?: number;
}

export type ProfileLimits = Partial<SandboxResourceLimits>;
export type IsolationTier = "os" | "vm";

export interface SandboxProfile {
  readonly name: string;
  readonly isolation: IsolationTier;
  /** Paths are untrusted patterns until compiled by PathCanonicalizer. */
  readonly readOnlyPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly deniedPaths: readonly string[];
  readonly network: SandboxNetworkPolicy;
  readonly environmentAllowlist: readonly string[];
  readonly limits: ProfileLimits;
}

export interface ProfileRegistry {
  get(name: string): Promise<SandboxProfile | undefined>;
}

/** Concrete restrictions; the backend must enforce these, not just re-check paths. */
export interface SandboxSpec {
  readonly isolation: IsolationTier;
  readonly readOnlyPaths: readonly CanonicalPath[];
  readonly writablePaths: readonly CanonicalPath[];
  readonly deniedPaths: readonly CanonicalPath[];
  readonly network: SandboxNetworkPolicy;
  readonly environmentAllowlist: readonly string[];
  readonly cwd: CanonicalPath;
  readonly limits: SandboxResourceLimits;
}

/** Declared needs inform policy; declarations do not themselves grant access. */
export interface ToolCapabilities {
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly networkHosts?: readonly HostRule[];
  readonly environmentVariables?: readonly string[];
  readonly spawnSubprocess?: boolean;
  /** Set for shell/code tools whose behavior cannot be statically described. */
  readonly generalPurposeSandbox?: boolean;
}

/** Executable and args are separate; a shell is never implied. */
export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** Untrusted overrides; broker must filter keys and values before launch. */
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export type NormalizedSandboxExecution =
  | { readonly kind: "command"; readonly command: SandboxCommand }
  | {
      /** Explicit opt-in for trusted application code; never an OS sandbox. */
      readonly kind: "trusted-in-process";
      readonly reason: string;
    };

export interface NormalizedSandboxRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly original: ToolExecutionRequest;
  readonly capabilities: ToolCapabilities;
  readonly execution: NormalizedSandboxExecution;
  /** Safe, user-facing description; must not contain secrets or raw credentials. */
  readonly display: string;
}

export interface NormalizationContext {
  readonly cwd: CanonicalPath;
  readonly sessionId: string;
}

export interface ToolNormalizer {
  normalize(
    request: ToolExecutionRequest,
    context: NormalizationContext,
  ): Promise<NormalizedSandboxRequest>;
}

export type PolicyLayer = "organization" | "user" | "project" | "session";
export type DecisionSource = PolicyLayer | "default" | "engine-error";
export type PolicyEffect = "allow" | "deny" | "escalate";

export interface PolicyRuleMatch {
  readonly tool?: string;
  /** Exact argv prefix; this is a UX/policy selector, never a security boundary. */
  readonly commandPrefix?: readonly string[];
}

export interface ScopeDelta {
  readonly addReadPaths: readonly CanonicalPath[];
  readonly addWritePaths: readonly CanonicalPath[];
  readonly addNetworkHosts: readonly HostRule[];
  readonly addEnvironmentVariables: readonly string[];
  readonly allowSubprocess: boolean;
}

/** Untrusted, serialized scope from a policy file; canonicalize before use. */
export interface PolicyRuleScope {
  readonly addReadPaths: readonly string[];
  readonly addWritePaths: readonly string[];
  readonly addNetworkHosts: readonly HostRule[];
  readonly addEnvironmentVariables: readonly string[];
  readonly allowSubprocess: boolean;
}

interface PolicyRuleBase {
  readonly id: string;
  readonly match: PolicyRuleMatch;
}

export type PolicyRule =
  | (PolicyRuleBase & {
      readonly effect: "allow";
      readonly profile: string;
    })
  | (PolicyRuleBase & {
      readonly effect: "deny";
      readonly reason?: string;
    })
  | (PolicyRuleBase & {
      readonly effect: "escalate";
      readonly profile: string;
      readonly scope: PolicyRuleScope;
      readonly reason?: string;
    });

export interface PolicyLayerContents {
  readonly layer: PolicyLayer;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly rules: readonly PolicyRule[];
}

export interface LoadedPolicy {
  /** Must be ordered organization, user, project, session; earlier layers win. */
  readonly layers: readonly PolicyLayerContents[];
}

export interface PolicyStore {
  /** Policy sources must be trusted and unwritable from sandboxed processes. */
  load(context: {
    readonly cwd: CanonicalPath;
    readonly sessionId: string;
  }): Promise<LoadedPolicy>;
}

export interface SandboxPolicyContext {
  readonly cwd: CanonicalPath;
  readonly sessionId: string;
  readonly policy: LoadedPolicy;
}

interface DecisionBase {
  readonly ruleId: string;
  readonly source: DecisionSource;
}

/** No matching rule must produce a deny decision with source `default`. */
export type SandboxPolicyDecision =
  | (DecisionBase & { readonly kind: "allow"; readonly profile: string })
  | (DecisionBase & { readonly kind: "deny"; readonly reason: string })
  | (DecisionBase & {
      readonly kind: "escalate";
      readonly reason: string;
      readonly profile: string;
      readonly scope: ScopeDelta;
    });

export interface SandboxPolicyEngine {
  /** First matching rule wins in the documented layer/rule order. */
  evaluate(
    request: NormalizedSandboxRequest,
    context: SandboxPolicyContext,
  ): Promise<SandboxPolicyDecision> | SandboxPolicyDecision;
}

export interface Grant {
  readonly id: string;
  /** Hash covers the exact session, expiry, and complete permission scope. */
  readonly scopeHash: string;
  readonly sessionId: string;
  readonly scope: ScopeDelta;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly approvedBy: string;
}

export type ApprovalOutcome =
  | { readonly kind: "approved"; readonly grant: Grant }
  | { readonly kind: "declined"; readonly reason?: string };

export interface SandboxViolation {
  readonly resource: string;
  readonly operation?: string;
  readonly detail?: string;
  readonly source: "backend" | "heuristic";
}

export interface ApprovalRequest {
  readonly request: NormalizedSandboxRequest;
  readonly reason: string;
  readonly profile: string;
  readonly scope: ScopeDelta;
  readonly scopeHash: string;
  readonly triggeredBy?: SandboxViolation;
}

export interface ApprovalProvider {
  request(approval: ApprovalRequest): Promise<ApprovalOutcome>;
  activeGrants(sessionId: string): Promise<readonly Grant[]>;
}

export interface SandboxProfileCompiler {
  /** Canonicalize paths and compile restrictions for backend enforcement. */
  compile(
    profile: SandboxProfile,
    request: NormalizedSandboxRequest,
    grants: readonly Grant[],
  ): Promise<SandboxSpec>;
}

export type BackendAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface BackendRunOptions {
  readonly signal: AbortSignal;
  /** Sanitized non-secret environment only; credentials belong in the proxy. */
  readonly environment: Readonly<Record<string, string>>;
  readonly proxySocketPath?: CanonicalPath;
}

export interface SandboxBackend {
  readonly name: string;
  readonly tier: IsolationTier;
  available(): Promise<BackendAvailability>;
  run(
    spec: SandboxSpec,
    command: SandboxCommand,
    options: BackendRunOptions,
  ): Promise<SandboxExecutionResult>;
}

export type TerminationReason =
  | "exit"
  | "signal"
  | "timeout"
  | "oom"
  | "output-limit"
  | "cancelled";

export interface SandboxExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly terminationReason: TerminationReason;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly backend: string;
  readonly violations: readonly SandboxViolation[];
}

export interface SandboxBroker {
  run(
    spec: SandboxSpec,
    command: SandboxCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SandboxExecutionResult>;
}

export interface TrustedInProcessExecutor {
  run(
    request: NormalizedSandboxRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SandboxExecutionResult>;
}

export interface UntrustedToolOutput {
  readonly trust: "untrusted";
  readonly text: string;
  readonly truncated: boolean;
  readonly redactionCount: number;
}

export interface ToolOutputFilter {
  filter(
    result: SandboxExecutionResult,
    request: NormalizedSandboxRequest,
  ): UntrustedToolOutput;
}

export interface SandboxAuditRecord {
  readonly timestamp: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  /** Hashes use a documented algorithm and exclude secret material. */
  readonly requestHash: string;
  /** If present, this must be redacted and bounded before persistence. */
  readonly commandPreview?: string;
  readonly decision: SandboxPolicyDecision["kind"];
  readonly ruleId: string;
  readonly decisionSource: DecisionSource;
  readonly denialReason?: string;
  readonly profileName?: string;
  readonly profileHash?: string;
  readonly specHash?: string;
  readonly approval?: {
    readonly grantId: string;
    readonly scopeHash: string;
    readonly approvedBy: string;
  };
  readonly backend?: string;
  readonly exitCode?: number | null;
  readonly terminationReason?: TerminationReason;
  readonly violations?: readonly SandboxViolation[];
  readonly durationMs?: number;
}

export interface SandboxAuditSink {
  record(entry: SandboxAuditRecord): Promise<void>;
}

export type SandboxFailureCode =
  | "normalization-failed"
  | "policy-error"
  | "profile-unknown"
  | "compile-failed"
  | "backend-unavailable"
  | "env-violation"
  | "audit-failed"
  | "approval-failed"
  | "execution-failed"
  | "output-filter-failed"
  | "cancelled"
  | "internal";

export type SandboxedToolOutcome =
  | {
      readonly kind: "completed";
      readonly requestId: string;
      readonly result: SandboxExecutionResult;
      readonly output: UntrustedToolOutput;
    }
  | {
      readonly kind: "denied";
      readonly requestId: string;
      readonly reason: string;
      readonly ruleId: string;
    }
  | {
      readonly kind: "approval-declined";
      readonly requestId: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "failed";
      readonly requestId: string;
      readonly code: SandboxFailureCode;
      readonly message: string;
    };

export interface SandboxedToolExecutorOptions {
  readonly auditFailureMode: "fail-closed" | "best-effort";
}

export interface SandboxedToolExecutorDeps {
  readonly normalizer: ToolNormalizer;
  readonly policyStore: PolicyStore;
  readonly policyEngine: SandboxPolicyEngine;
  readonly profiles: ProfileRegistry;
  readonly approvals: ApprovalProvider;
  readonly compiler: SandboxProfileCompiler;
  readonly broker: SandboxBroker;
  readonly trustedInProcess: TrustedInProcessExecutor;
  readonly outputFilter: ToolOutputFilter;
  readonly audit: SandboxAuditSink;
  readonly options: SandboxedToolExecutorOptions;
}

export interface SandboxedToolExecutor {
  /** Requests without a command must use an explicitly trusted in-process path. */
  execute(
    request: ToolExecutionRequest,
    context: NormalizationContext,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SandboxedToolOutcome>;
}
