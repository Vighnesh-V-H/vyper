import { describe, expect, test } from "bun:test";
import { ErrorCode, SandboxFailure } from "../src/errors";
import {
  CredentialInjectionRuleSchema,
  HostRuleSchema,
  LoadedPolicySchema,
  PolicyRuleSchema,
  ProfileSpecSchema,
} from "../src/schema/sandbox";

describe("sandbox configuration schemas", () => {
  test("SandboxFailure uses the centralized error contract", () => {
    const error = new SandboxFailure("policy-error", "policy unavailable");
    expect(error.code).toBe(ErrorCode.SandboxFailure);
    expect(error.failureCode).toBe("policy-error");
  });

  test("applies safe profile and host defaults", () => {
    expect(HostRuleSchema.parse({ host: "api.example.com" })).toEqual({
      host: "api.example.com",
      ports: [443],
    });
    expect(ProfileSpecSchema.parse({ name: "restricted" })).toMatchObject({
      isolation: "os",
      network: { kind: "none" },
      limits: {},
    });
  });

  test("rejects malformed network hosts and credential headers", () => {
    expect(() => HostRuleSchema.parse({ host: "*.localhost" })).toThrow();
    expect(() => HostRuleSchema.parse({ host: "api.example.com", ports: [] })).toThrow();
    expect(() =>
      CredentialInjectionRuleSchema.parse({
        host: "api.example.com",
        secretId: "token",
        header: "Authorization\r\nX-Evil: yes",
      }),
    ).toThrow();
  });

  test("requires policy layers to be unique and in priority order", () => {
    const layer = (name: "organization" | "user") => ({
      layer: name,
      sourcePath: `${name}.yaml`,
      contentHash: "hash",
      rules: [],
    });
    expect(LoadedPolicySchema.parse({ layers: [layer("organization"), layer("user")] })).toBeDefined();
    expect(() =>
      LoadedPolicySchema.parse({ layers: [layer("user"), layer("organization")] }),
    ).toThrow();
    expect(() =>
      LoadedPolicySchema.parse({ layers: [layer("user"), layer("user")] }),
    ).toThrow();
  });

  test("requires selectors and effect-specific policy fields", () => {
    expect(() =>
      PolicyRuleSchema.parse({ id: "r1", effect: "allow", match: { tool: "bash" } }),
    ).toThrow();
    expect(() =>
      PolicyRuleSchema.parse({ id: "r2", effect: "allow", profile: "p", match: {} }),
    ).toThrow();
    expect(() =>
      PolicyRuleSchema.parse({
        id: "r3",
        effect: "escalate",
        profile: "p",
        match: { tool: "bash" },
      }),
    ).toThrow();
    expect(
      PolicyRuleSchema.parse({
        id: "r4",
        effect: "allow",
        profile: "read-only",
        match: { commandPrefix: ["git", "status"] },
      }),
    ).toMatchObject({ effect: "allow", profile: "read-only" });
  });
});
