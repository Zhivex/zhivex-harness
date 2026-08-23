import { describe, expect, test } from "bun:test";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import {
  DEFAULT_PROVIDER_REGISTRY,
  HARNESS_CONFIG_MIGRATABLE_SCHEMA_VERSIONS,
  HARNESS_CONFIG_SCHEMA_VERSION,
  HARNESS_EXECUTION_POLICY_VERSION,
  createProviderModel,
  createProviderRegistry,
  migrateHarnessConfigInput,
  parseProvider,
  providerAvailability,
  resolveHarnessConfig
} from "../src/config.js";

describe("provider configuration", () => {
  test("migrates schema 4 inputs without enabling new trust surfaces", () => {
    expect(HARNESS_CONFIG_MIGRATABLE_SCHEMA_VERSIONS).toEqual([4, 5]);
    const migrated = migrateHarnessConfigInput({
      schemaVersion: 4,
      provider: "openai",
      workspace: ".",
      executionBackend: "oci",
      ociAllowedCommands: ["node", "npm"]
    });
    expect(migrated).toMatchObject({
      fromVersion: 4,
      toVersion: 5,
      config: {
        schemaVersion: 5,
        projectContext: false,
        ociShellMode: "deny"
      }
    });
    expect(resolveHarnessConfig(migrated.config)).toMatchObject({
      schemaVersion: 5,
      context: { enabled: false },
      execution: { backend: "oci", shellMode: "deny" }
    });
    expect(migrated.notes).toHaveLength(2);
  });

  test("keeps schema 5 migration idempotent and rejects unversioned or unknown inputs", () => {
    const current = { schemaVersion: 5, provider: "qwen", projectContext: true } as const;
    expect(migrateHarnessConfigInput(current)).toEqual({
      fromVersion: 5,
      toVersion: 5,
      config: current,
      notes: []
    });
    expect(() => migrateHarnessConfigInput({ provider: "openai" })).toThrow("Supported source versions");
    expect(() => migrateHarnessConfigInput({ schemaVersion: 3 })).toThrow("Supported source versions");
    expect(() => migrateHarnessConfigInput({ schemaVersion: 6 })).toThrow("Supported source versions");
  });

  test("resolves stable defaults for every provider", () => {
    expect(resolveHarnessConfig({ provider: "meta", workspace: "." })).toMatchObject({
      schemaVersion: HARNESS_CONFIG_SCHEMA_VERSION,
      model: "muse-spark-1.2",
      storeBackend: "sqlite",
      scope: { tenantId: "local" },
      budget: { maxToolCalls: 32, maxTotalTokens: 120_000 },
      compaction: { maxMessages: 60, keepRecentMessages: 12 },
      requiredCapabilities: ["streaming", "tools"],
      orchestration: {
        profiles: ["explorer", "implementer", "tester", "reviewer"],
        childBudget: { maxSteps: 8, maxToolCalls: 16, maxTotalTokens: 36_000 },
        maxParallelReviews: 2
      },
      context: { enabled: true }
    });
    expect(resolveHarnessConfig({ provider: "qwen", workspace: "." }).model).toBe("qwen3.8-max");
    expect(resolveHarnessConfig({ provider: "openai", workspace: "." }).model).toBe("gpt-5.6-luna");
    expect(resolveHarnessConfig({ provider: "gemini", workspace: "." }).model).toBe("gemini-3.6-flash");
    expect(resolveHarnessConfig({ provider: "openai", workspace: "." }).allowedChecks).toEqual([
      "test",
      "typecheck",
      "lint",
      "build"
    ]);
  });

  test("rejects unknown providers and invalid step budgets", () => {
    expect(() => parseProvider("deepseek")).toThrow("Unknown provider");
    expect(() => resolveHarnessConfig({ provider: "openai", maxSteps: 0 })).toThrow("maxSteps");
    expect(() => resolveHarnessConfig({ provider: "openai", maxSteps: 51 })).toThrow("maxSteps");
    expect(() => resolveHarnessConfig({ schemaVersion: 3 })).toThrow("Unsupported config schema");
    expect(() => resolveHarnessConfig({ storeBackend: "postgres" })).toThrow("storeBackend");
    expect(() => resolveHarnessConfig({ maxToolErrors: -1 })).toThrow("maxToolErrors");
    expect(() => resolveHarnessConfig({ maxInputTokens: 10_000, maxTotalTokens: 5_000 })).toThrow("maxTotalTokens");
    expect(() => resolveHarnessConfig({ maxCostUsd: 1 })).toThrow("requires");
    expect(() => resolveHarnessConfig({ inputCostPerMillion: 10 })).toThrow("requires maxCostUsd");
    expect(() => resolveHarnessConfig({ allowedChecks: ["test", "../../escape"] })).toThrow("Invalid allowed check");
    expect(() => resolveHarnessConfig({
      allowedChecks: Array.from({ length: 51 }, (_, index) => `check-${index}`)
    })).toThrow("more than 50");
    expect(() => resolveHarnessConfig({ requiredCapabilities: ["telepathy"] })).toThrow("Unknown required capability");
    expect(() => resolveHarnessConfig({ subagentProfiles: ["deployer"] })).toThrow("Unknown subagent profile");
    expect(() => resolveHarnessConfig({ subagentMaxInputTokens: 50, subagentMaxTotalTokens: 10 })).toThrow("subagentMaxTotalTokens");
    expect(resolveHarnessConfig({ projectContext: false }).context.enabled).toBe(false);
    expect(() => resolveHarnessConfig({ contextConfigPath: "../outside.json" }))
      .toThrow("inside the workspace");
    try {
      resolveHarnessConfig({ executionBackend: "host" });
      throw new Error("Expected invalid execution config to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        name: "HarnessConfigError",
        code: "CONFIG_INVALID",
        category: "configuration",
        retryable: false
      });
    }
  });

  test("resolves a bounded no-network OCI policy and rejects unsafe execution configuration", () => {
    expect(resolveHarnessConfig({ executionBackend: "oci" }).execution).toMatchObject({
      backend: "oci",
      policyVersion: HARNESS_EXECUTION_POLICY_VERSION,
      image: "node:24-bookworm-slim",
      allowedCommands: ["node", "npm"],
      shellMode: "deny"
    });
    expect(resolveHarnessConfig({
      executionBackend: "oci",
      ociRuntime: "podman",
      ociImage: "registry.example/zhivex-node@sha256:fixture",
      ociAllowedCommands: ["npm", "git", "npm"],
      ociShellMode: "ask",
      ociMaxMemoryMb: 512,
      ociMaxPids: 64
    }).execution).toMatchObject({
      backend: "oci",
      runtime: "podman",
      image: "registry.example/zhivex-node@sha256:fixture",
      allowedCommands: ["npm", "git"],
      shellMode: "ask",
      maxMemoryMb: 512,
      maxPids: 64
    });
    expect(() => resolveHarnessConfig({ executionBackend: "host" })).toThrow("executionBackend");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociRuntime: "shell" })).toThrow("ociRuntime");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociShellMode: "allow" })).toThrow("ociShellMode");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociImage: "-unsafe" })).toThrow("ociImage");
    expect(resolveHarnessConfig({ executionBackend: "oci", ociAllowedCommands: ["bun"] }).execution)
      .toMatchObject({ allowedCommands: ["bun"] });
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociAllowedCommands: ["git"] })).toThrow("include npm, pnpm, yarn, or bun");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociAllowedCommands: ["npm", "../sh"] })).toThrow("Invalid OCI command");
    expect(() => resolveHarnessConfig({
      executionBackend: "oci",
      ociMaxWorkspaceBytes: 1024 * 1024,
      ociMaxFileWriteBytes: 2 * 1024 * 1024
    })).toThrow("cannot exceed");
  });

  test("resolves explicit scope, budgets, compaction, and cost pricing", () => {
    const config = resolveHarnessConfig({
      workspace: "/tmp/example",
      tenantId: "tenant-a",
      userId: "user-7",
      namespace: "project-x",
      maxToolCalls: 8,
      timeoutMs: 60_000,
      compactionMaxMessages: 20,
      compactionKeepRecentMessages: 6,
      maxCostUsd: 2.5,
      inputCostPerMillion: 10,
      outputCostPerMillion: 30
    });
    expect(config).toMatchObject({
      scope: { tenantId: "tenant-a", userId: "user-7", namespace: "project-x" },
      timeoutMs: 60_000,
      budget: { maxToolCalls: 8 },
      compaction: { maxMessages: 20, keepRecentMessages: 6 },
      costBudget: {
        maxCostUsd: 2.5,
        inputCostPer1kTokens: 0.01,
        outputCostPer1kTokens: 0.03
      }
    });
    const blankScope = resolveHarnessConfig({ workspace: ".", tenantId: " ", namespace: " " });
    expect(blankScope.scope.tenantId).toBe("local");
    expect(blankScope.scope.namespace).toMatch(/^workspace-[a-f0-9]{16}$/);
  });

  test("supports an explicit, deduplicated check allowlist", () => {
    expect(resolveHarnessConfig({ allowedChecks: ["format", "test:unit", "format"] }).allowedChecks).toEqual([
      "format",
      "test:unit"
    ]);
    expect(resolveHarnessConfig({ allowedChecks: [] }).allowedChecks).toEqual([]);
  });

  test("builds native provider models without making a request", () => {
    expect(createProviderModel(
      { provider: "meta", model: "muse-spark-1.2" },
      { MODEL_API_KEY: "meta-test" }
    )).toMatchObject({ provider: "meta", modelId: "muse-spark-1.2" });

    expect(createProviderModel(
      { provider: "qwen", model: "qwen3.8-max" },
      { DASHSCOPE_API_KEY: "qwen-test", QWEN_REGION: "singapore" }
    )).toMatchObject({ provider: "qwen", modelId: "qwen3.8-max" });

    expect(createProviderModel(
      { provider: "openai", model: "gpt-5.6-luna" },
      { OPENAI_API_KEY: "openai-test" }
    )).toMatchObject({ provider: "openai", modelId: "gpt-5.6-luna" });

    expect(createProviderModel(
      { provider: "gemini", model: "gemini-3.6-flash" },
      { GOOGLE_GENERATIVE_AI_API_KEY: "gemini-test" }
    )).toMatchObject({ provider: "gemini", modelId: "gemini-3.6-flash" });
  });

  test("accepts an injected registry across config, factories, and availability", () => {
    let selectedCredential: string | undefined;
    const registry = DEFAULT_PROVIDER_REGISTRY.extend([{
      descriptor: {
        id: "local-fixture",
        name: "Local fixture",
        defaultModel: "fixture-v1",
        credentialNames: ["FIXTURE_TOKEN"],
        capabilities: ["streaming", "tool-calling"],
        support: "provisional"
      },
      diagnostics: {
        endpointEnvironmentVariable: "FIXTURE_BASE_URL",
        presence: [{ key: "project", environmentVariable: "FIXTURE_PROJECT" }],
        enums: [{
          key: "region",
          environmentVariable: "FIXTURE_REGION",
          allowedValues: ["local", "remote"]
        }]
      },
      factory: ({ model, credentials }) => {
        selectedCredential = credentials.require();
        return createMockLanguageModel({ provider: "local-fixture", modelId: model });
      }
    }]);

    const config = resolveHarnessConfig({ provider: "LOCAL-FIXTURE", workspace: "." }, registry);
    expect(config).toMatchObject({ provider: "local-fixture", model: "fixture-v1" });
    expect(parseProvider("local-fixture", registry)).toBe("local-fixture");
    expect(createProviderModel(config, { FIXTURE_TOKEN: "token" }, registry)).toMatchObject({
      provider: "local-fixture",
      modelId: "fixture-v1"
    });
    expect(selectedCredential).toBe("token");

    const availability = providerAvailability({
      FIXTURE_TOKEN: "do-not-return",
      FIXTURE_BASE_URL: "https://user:secret@example.invalid/v1",
      FIXTURE_PROJECT: "sensitive-project",
      FIXTURE_REGION: "unknown-region"
    }, registry);
    const fixture = availability.find((provider) => provider.id === "local-fixture");
    expect(fixture).toMatchObject({
      configured: true,
      credentials: [{ name: "FIXTURE_TOKEN", present: true }],
      configuration: {
        customEndpoint: true,
        endpointValid: false,
        endpointSecure: true,
        projectConfigured: true,
        regionConfigured: true,
        regionValid: false
      }
    });
    expect(JSON.stringify(fixture)).not.toContain("do-not-return");
    expect(JSON.stringify(fixture)).not.toContain("user:secret");
    expect(JSON.stringify(fixture)).not.toContain("sensitive-project");
    expect(JSON.stringify(fixture)).not.toContain("unknown-region");
  });

  test("validates provider registrations before they become selectable", () => {
    const registration = {
      descriptor: {
        id: "fixture",
        name: "Fixture",
        defaultModel: "fixture-v1",
        credentialNames: [] as const,
        capabilities: ["streaming"] as const,
        support: "provisional" as const
      },
      factory: () => createMockLanguageModel({ provider: "fixture", modelId: "fixture-v1" })
    };
    const standalone = createProviderRegistry([registration]);
    expect(standalone.parse()).toBe("fixture");
    expect(resolveHarnessConfig({}, standalone)).toMatchObject({
      provider: "fixture",
      model: "fixture-v1"
    });
    expect(() => createProviderRegistry([])).toThrow("at least one provider");
    expect(() => createProviderRegistry([registration, registration])).toThrow("Duplicate provider");
    expect(() => createProviderRegistry([{
      ...registration,
      descriptor: { ...registration.descriptor, id: "../plugin" }
    }])).toThrow("Invalid provider id");
    expect(() => createProviderRegistry([{
      ...registration,
      diagnostics: {
        endpointEnvironmentVariable: "FIXTURE_URL",
        presence: [{ key: "bad-key", environmentVariable: "FIXTURE_VALUE" }]
      }
    }])).toThrow("Invalid provider diagnostic key");
  });

  test("reports credential presence without returning values", () => {
    const providers = providerAvailability({
      OPENAI_API_KEY: "super-secret-api-key",
      OPENAI_BASE_URL: "https://user:secret@example.invalid/v1"
    });
    const openai = providers.find((provider) => provider.id === "openai");
    expect(openai).toMatchObject({
      configured: true,
      credentials: [{ name: "OPENAI_API_KEY", present: true }],
      configuration: { customEndpoint: true, endpointValid: false, endpointSecure: true }
    });
    expect(openai?.capabilities).toEqual(["streaming", "tool-calling", "approval-resume"]);
    expect(openai?.support).toBe("certified");
    expect(JSON.stringify(providers)).not.toContain("super-secret-api-key");
    expect(JSON.stringify(providers)).not.toContain("user:secret");
  });

  test("reports the repeatably certified provider matrix", () => {
    const providers = providerAvailability({ MODEL_API_KEY: "present" });
    expect(providers.find((provider) => provider.id === "meta")?.support).toBe("certified");
    expect(providers.find((provider) => provider.id === "qwen")?.support).toBe("certified");
    expect(providers.find((provider) => provider.id === "gemini")?.support).toBe("provisional");
  });

  test("reports Gemini credentials and endpoints without disclosing their values", () => {
    const providers = providerAvailability({
      GEMINI_API_KEY: "gemini-super-secret",
      GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta"
    });
    const gemini = providers.find((provider) => provider.id === "gemini");
    expect(gemini).toMatchObject({
      configured: true,
      credentials: [
        { name: "GEMINI_API_KEY", present: true },
        { name: "GOOGLE_GENERATIVE_AI_API_KEY", present: false }
      ],
      configuration: {
        customEndpoint: true,
        endpointValid: true,
        endpointSecure: true
      }
    });
    expect(JSON.stringify(gemini)).not.toContain("gemini-super-secret");
    expect(JSON.stringify(gemini)).not.toContain("generativelanguage.googleapis.com");
  });

  test("diagnoses Qwen option presence and validity without returning values", () => {
    const qwen = providerAvailability({
      QWEN_API_KEY: "secret",
      QWEN_REGION: "invalid-region",
      QWEN_WORKSPACE_ID: "private-workspace-id"
    }).find((provider) => provider.id === "qwen");

    expect(qwen?.configuration).toMatchObject({
      customEndpoint: false,
      endpointValid: true,
      endpointSecure: true,
      regionConfigured: true,
      regionValid: false,
      workspaceIdConfigured: true
    });
    expect(JSON.stringify(qwen)).not.toContain("invalid-region");
    expect(JSON.stringify(qwen)).not.toContain("private-workspace-id");
  });
});
