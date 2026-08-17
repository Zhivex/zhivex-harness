import { describe, expect, test } from "bun:test";

import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import {
  assertHarnessModelCapabilities,
  inspectHarnessModelCapabilities,
  selectHarnessModel
} from "../src/capabilities.js";

describe("capability routing", () => {
  test("rejects an incompatible model before any run begins", () => {
    const model = createMockLanguageModel({
      provider: "limited",
      modelId: "no-tools",
      capabilities: { tools: false, streaming: true }
    });
    expect(inspectHarnessModelCapabilities(model)).toMatchObject({
      provider: "limited",
      model: "no-tools",
      capabilities: { streaming: true, tools: false }
    });
    expect(() => assertHarnessModelCapabilities(model, ["tools"], "MCP flow"))
      .toThrow("cannot enter the MCP flow: missing tools");
  });

  test("selects the highest-priority compatible candidate deterministically", () => {
    const limited = createMockLanguageModel({
      provider: "limited",
      modelId: "limited",
      capabilities: { tools: false }
    });
    const first = createMockLanguageModel({
      provider: "portable",
      modelId: "first",
      capabilities: { tools: true, streaming: true, structuredOutput: false }
    });
    const preferred = createMockLanguageModel({
      provider: "portable",
      modelId: "preferred",
      capabilities: { tools: true, streaming: true, structuredOutput: true }
    });
    const selection = selectHarnessModel([
      { id: "limited", model: limited, priority: 100 },
      { id: "first", model: first },
      { id: "preferred", model: preferred, priority: 1 }
    ], ["streaming", "tools"]);
    expect(selection).toMatchObject({ id: "preferred", model: { modelId: "preferred" } });
    expect(() => selectHarnessModel([{ model: limited }], ["tools"]))
      .toThrow("No model candidate satisfies");
  });
});
