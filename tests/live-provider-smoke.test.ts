import { describe, expect, test } from "bun:test";

import { liveProviderSmokeInternals } from "../scripts/live-provider-smoke.js";

const {
  assertLiveOptIn,
  certificationPrompt,
  errorEvidence,
  parsePhaseArguments,
  providerRunInput,
  redacted,
  requireCredentials,
  selectedProviders
} = liveProviderSmokeInternals;

describe("live provider smoke contract", () => {
  test("fails closed unless live network use is explicitly enabled", () => {
    expect(() => assertLiveOptIn({})).toThrow("ZHIVEX_HARNESS_LIVE=1");
    expect(() => assertLiveOptIn({ ZHIVEX_HARNESS_LIVE: "true" })).toThrow("ZHIVEX_HARNESS_LIVE=1");
    expect(() => assertLiveOptIn({ ZHIVEX_HARNESS_LIVE: "1" })).not.toThrow();
  });

  test("defaults to the complete provider matrix and validates subsets", () => {
    expect(selectedProviders({})).toEqual(["meta", "qwen", "openai"]);
    expect(selectedProviders({ ZHIVEX_HARNESS_LIVE_PROVIDERS: "openai, qwen,openai" })).toEqual([
      "openai",
      "qwen"
    ]);
    expect(() => selectedProviders({ ZHIVEX_HARNESS_LIVE_PROVIDERS: "unknown" })).toThrow(
      "Unknown provider"
    );
  });

  test("requires credentials by name without exposing credential values", () => {
    expect(() => requireCredentials(["meta", "qwen", "openai"], {
      MODEL_API_KEY: "meta-secret",
      DASHSCOPE_API_KEY: "qwen-secret"
    })).toThrow("openai");
    expect(() => requireCredentials(["meta", "qwen", "openai"], {
      MODEL_API_KEY: "meta-secret",
      DASHSCOPE_API_KEY: "qwen-secret",
      OPENAI_API_KEY: "openai-secret"
    })).not.toThrow();
  });

  test("redacts secrets from text and structured error evidence", () => {
    const env = {
      OPENAI_API_KEY: "live-super-secret",
      OPENAI_BASE_URL: "https://private-endpoint.example/v1"
    };
    expect(redacted("before live-super-secret https://private-endpoint.example/v1 after", env)).toBe(
      "before [REDACTED] [REDACTED] after"
    );

    const error = new Error("request rejected for live-super-secret");
    const evidence = errorEvidence(error, env);
    expect(() => JSON.parse(evidence)).not.toThrow();
    expect(evidence).not.toContain("live-super-secret");
    expect(evidence).toContain("[REDACTED]");
  });

  test("accepts only complete orchestrator-owned child phase arguments", () => {
    expect(parsePhaseArguments([])).toBeUndefined();
    expect(parsePhaseArguments([
      "--phase", "request",
      "--provider", "qwen",
      "--model", "qwen3.8-max",
      "--workspace", "/tmp/workspace",
      "--state-dir", "/tmp/workspace/.zhivex-harness/runs"
    ])).toMatchObject({ phase: "request", provider: "qwen", model: "qwen3.8-max" });
    expect(() => parsePhaseArguments([
      "--phase", "resume",
      "--provider", "qwen",
      "--model", "qwen3.8-max",
      "--workspace", "/tmp/workspace",
      "--state-dir", "/tmp/workspace/.zhivex-harness/runs"
    ])).toThrow("runId");
  });

  test("certifies the proposal before requesting approval to apply it", () => {
    const prompt = certificationPrompt("meta");
    expect(prompt).toContain("Call propose_edits exactly once");
    expect(prompt).toContain("then call apply_patch exactly once");
    expect(prompt.indexOf("propose_edits")).toBeLessThan(prompt.indexOf("apply_patch"));

    const input = providerRunInput("meta", prompt);
    expect(input.toolChoice).toBe("auto");
    expect(input.providerOptions).toBeUndefined();
    expect(providerRunInput("qwen", prompt).providerOptions).toEqual({ apiMode: "responses" });
    expect(providerRunInput("openai", prompt).providerOptions).toEqual({ apiMode: "responses" });
  });
});
