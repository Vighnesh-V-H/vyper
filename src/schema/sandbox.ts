import { z } from "zod";
import type {
  CredentialInjectionRule,
  HostRule,
  LoadedPolicy,
  PolicyLayer,
  PolicyLayerContents,
  PolicyRule,
  SandboxNetworkPolicy,
  SandboxProfile,
  SandboxResourceLimits,
} from "../types/sandbox";

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const HEADER_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const HostRuleSchema: z.ZodType<HostRule> = z
  .object({
    host: z.string().regex(HOST_PATTERN, "must be an exact hostname or *.suffix with at least one dot"),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).default([443]),
  })
  .strict();

export const CredentialInjectionRuleSchema: z.ZodType<CredentialInjectionRule> = z
  .object({
    host: z.string().regex(HOST_PATTERN),
    secretId: z.string().min(1),
    header: z.string().regex(HEADER_PATTERN).default("Authorization"),
    scheme: z.string().regex(/^[A-Za-z][A-Za-z0-9+.-]*$/).optional(),
  })
  .strict();

export const NetworkPolicySchema: z.ZodType<SandboxNetworkPolicy> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("proxy"),
      allowedHosts: z.array(HostRuleSchema),
      allowLoopback: z.boolean().default(false),
      allowIpLiterals: z.boolean().default(false),
      credentialRules: z.array(CredentialInjectionRuleSchema).default([]),
    })
    .strict(),
]);

export const ResourceLimitsSchema = z
  .object({
    wallTimeMs: z.number().int().positive(),
    memoryBytes: z.number().int().positive(),
    processCount: z.number().int().positive(),
    outputBytes: z.number().int().positive(),
    cpuTimeMs: z.number().int().positive().optional(),
  })
  .strict() satisfies z.ZodType<SandboxResourceLimits>;

export const ProfileLimitsSchema = ResourceLimitsSchema.partial();

export const IsolationTierSchema = z.enum(["os", "vm"]);

export const ProfileSpecSchema = z
  .object({
    name: z.string().min(1),
    isolation: IsolationTierSchema.default("os"),
    readOnlyPaths: z.array(z.string()).default([]),
    writablePaths: z.array(z.string()).default([]),
    deniedPaths: z.array(z.string()).default([]),
    network: NetworkPolicySchema.default({ kind: "none" }),
    environmentAllowlist: z.array(z.string()).default([]),
    limits: ProfileLimitsSchema.default({}),
  })
  .strict() satisfies z.ZodType<SandboxProfile>;

const PolicyRuleScopeSchema = z
  .object({
    addReadPaths: z.array(z.string()).default([]),
    addWritePaths: z.array(z.string()).default([]),
    addNetworkHosts: z.array(HostRuleSchema).default([]),
    addEnvironmentVariables: z.array(z.string()).default([]),
    allowSubprocess: z.boolean().default(false),
  })
  .strict();

const MatchSchema = z
  .object({
    tool: z.string().min(1).optional(),
    commandPrefix: z.array(z.string()).min(1).optional(),
  })
  .strict()
  .refine((match) => match.tool !== undefined || match.commandPrefix !== undefined, {
    message: "at least one of tool or commandPrefix is required",
  });

const RuleBaseSchema = z.object({ id: z.string().min(1), match: MatchSchema }).strict();

export const PolicyRuleSchema: z.ZodType<PolicyRule> = z.discriminatedUnion("effect", [
  RuleBaseSchema.extend({
    effect: z.literal("allow"),
    profile: z.string().min(1),
  }).strict(),
  RuleBaseSchema.extend({
    effect: z.literal("deny"),
    reason: z.string().optional(),
  }).strict(),
  RuleBaseSchema.extend({
    effect: z.literal("escalate"),
    profile: z.string().min(1),
    scope: PolicyRuleScopeSchema,
    reason: z.string().optional(),
  }).strict(),
]);

export const PolicyLayerSchema = z.enum([
  "organization",
  "user",
  "project",
  "session",
]);

export const PolicyLayerContentsSchema: z.ZodType<PolicyLayerContents> = z
  .object({
    layer: PolicyLayerSchema,
    sourcePath: z.string().min(1),
    contentHash: z.string().min(1),
    rules: z.array(PolicyRuleSchema),
  })
  .strict();

const LAYER_PRIORITY: readonly PolicyLayer[] = [
  "organization",
  "user",
  "project",
  "session",
];

/** Layers may be omitted, but present layers must retain the fixed priority order. */
export const LoadedPolicySchema: z.ZodType<LoadedPolicy> = z
  .object({ layers: z.array(PolicyLayerContentsSchema) })
  .strict()
  .refine(
    ({ layers }) =>
      layers.every(
        (entry, index) =>
          index === 0 ||
          LAYER_PRIORITY.indexOf(layers[index - 1]!.layer) <
            LAYER_PRIORITY.indexOf(entry.layer),
      ),
    {
      message:
        "policy layers must be unique and ordered organization > user > project > session",
    },
  );
