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
      model: "muse-spark-1.2"
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
    expect(() => resolveHarnessConfig({ schemaVersion: 2 })).toThrow("Unsupported config schema");
    expect(() => resolveHarnessConfig({ allowedChecks: ["test", "../../escape"] })).toThrow("Invalid allowed check");
    expect(() => resolveHarnessConfig({
      allowedChecks: Array.from({ length: 51 }, (_, index) => `check-${index}`)
    })).toThrow("more than 50");
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
