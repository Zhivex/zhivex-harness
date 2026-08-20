import { describe, expect, test } from "bun:test";

import { DEFAULT_PROVIDER_REGISTRY } from "../src/config.js";
import {
  parseHarnessModelRoute,
  resolveHarnessModelRoutes,
  serializeHarnessModelRoutes
} from "../src/routing.js";

describe("multi-provider model routing", () => {
  test("uses provider defaults and preserves explicit model ids", () => {
    expect(parseHarnessModelRoute("reviewer=gemini")).toEqual({
      profile: "reviewer",
      provider: "gemini",
      model: DEFAULT_PROVIDER_REGISTRY.descriptor("gemini").defaultModel
    });
    expect(parseHarnessModelRoute("tester=openai:gpt-5.4-mini")).toEqual({
      profile: "tester",
      provider: "openai",
      model: "gpt-5.4-mini"
    });
  });

  test("rejects ambiguous, duplicate, and unknown routes", () => {
    expect(() => parseHarnessModelRoute("gemini")).toThrow("<profile>=<provider>");
    expect(() => parseHarnessModelRoute("manager=gemini")).toThrow("Invalid route");
    expect(() => parseHarnessModelRoute("reviewer=unknown")).toThrow("Unknown provider");
    expect(() => resolveHarnessModelRoutes([
      "reviewer=gemini",
      "reviewer=openai"
    ])).toThrow("Duplicate model route");
  });

  test("serializes only provider and model routing metadata", () => {
    expect(serializeHarnessModelRoutes(resolveHarnessModelRoutes([
      "explorer=qwen",
      "reviewer=gemini:gemini-3.6-flash"
    ]))).toEqual({
      explorer: { provider: "qwen", model: "qwen3.8-max" },
      reviewer: { provider: "gemini", model: "gemini-3.6-flash" }
    });
  });
});
