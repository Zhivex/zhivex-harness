import { describe, expect, test } from "bun:test";

import {
  HARNESS_CONFIG_SCHEMA_VERSION,
  createProviderModel,
  parseProvider,
  providerAvailability,
  resolveHarnessConfig
} from "../src/config.js";

describe("provider configuration", () => {
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
      }
    });
    expect(resolveHarnessConfig({ provider: "qwen", workspace: "." }).model).toBe("qwen3.8-max");
    expect(resolveHarnessConfig({ provider: "openai", workspace: "." }).model).toBe("gpt-5.4");
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
  });

  test("resolves a bounded no-network OCI policy and rejects unsafe execution configuration", () => {
    expect(resolveHarnessConfig({
      executionBackend: "oci",
      ociRuntime: "podman",
      ociImage: "registry.example/zhivex-bun@sha256:fixture",
      ociAllowedCommands: ["bun", "git", "bun"],
      ociMaxMemoryMb: 512,
      ociMaxPids: 64
    }).execution).toMatchObject({
      backend: "oci",
      runtime: "podman",
      image: "registry.example/zhivex-bun@sha256:fixture",
      allowedCommands: ["bun", "git"],
      maxMemoryMb: 512,
      maxPids: 64
    });
    expect(() => resolveHarnessConfig({ executionBackend: "host" })).toThrow("executionBackend");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociRuntime: "shell" })).toThrow("ociRuntime");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociImage: "-unsafe" })).toThrow("ociImage");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociAllowedCommands: ["git"] })).toThrow("include bun");
    expect(() => resolveHarnessConfig({ executionBackend: "oci", ociAllowedCommands: ["bun", "../sh"] })).toThrow("Invalid OCI command");
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
      { provider: "openai", model: "gpt-5.4" },
      { OPENAI_API_KEY: "openai-test" }
    )).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
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
