import { describe, expect, test } from "bun:test";

import {
  createProviderModel,
  parseProvider,
  providerAvailability,
  resolveHarnessConfig
} from "../src/config.js";

describe("provider configuration", () => {
  test("resolves stable defaults for every provider", () => {
    expect(resolveHarnessConfig({ provider: "meta", workspace: "." }).model).toBe("muse-spark-1.2");
    expect(resolveHarnessConfig({ provider: "qwen", workspace: "." }).model).toBe("qwen3.8-max");
    expect(resolveHarnessConfig({ provider: "openai", workspace: "." }).model).toBe("gpt-5.4");
  });

  test("rejects unknown providers and invalid step budgets", () => {
    expect(() => parseProvider("deepseek")).toThrow("Unknown provider");
    expect(() => resolveHarnessConfig({ provider: "openai", maxSteps: 0 })).toThrow("maxSteps");
    expect(() => resolveHarnessConfig({ provider: "openai", maxSteps: 51 })).toThrow("maxSteps");
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
    const providers = providerAvailability({ OPENAI_API_KEY: "secret" });
    expect(providers.find((provider) => provider.id === "openai")?.configured).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("secret");
  });
});
