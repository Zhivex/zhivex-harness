import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { modelReasoningEfforts, withReasoningEffort } from "../src/providers/reasoning.js";
import { createCliProfile, applyCliProfile } from "../src/cli/cli-profiles.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { harnessConfigInput } from "../src/cli/resume-metadata.js";

test("reasoning choices use SDK capabilities without provider requests", () => {
  expect(modelReasoningEfforts("qwen", "qwen3.8-flash")).toContain("low");
  expect(modelReasoningEfforts("openai", "gpt-6-astra")).not.toContain("none");
  expect(modelReasoningEfforts("custom", "unknown")).toEqual(["default"]);
  expect(modelReasoningEfforts("meta", "muse-spark-1.3")).toEqual(["default"]);
});
test("reasoning is applied to generate and stream and unsupported levels fail before calls", async () => {
  const base = createMockLanguageModel({responses:[{text:"ok"}],streamEvents:[[{type:"text-delta",textDelta:"ok"},{type:"finish",finishReason:"stop"}]]});
  const seen: unknown[] = [];
  const model = {...base, capabilities: {...base.capabilities, reasoning:true, reasoningEfforts:["low" as const]},
    generate: async (input: Parameters<typeof base.generate>[0]) => { seen.push(input.reasoning); return base.generate(input); },
    stream: async (input: Parameters<typeof base.generate>[0]) => { seen.push(input.reasoning); return base.stream!(input); }};
  const wrapped = withReasoningEffort(model, "low");
  await wrapped.generate({messages:[]});
  for await (const _ of await wrapped.stream!({messages:[]})) { }
  expect(seen).toEqual([{effort:"low"},{effort:"low"}]);
  expect(() => withReasoningEffort(model,"high")).toThrow("not declared");
  expect(withReasoningEffort(model,"default")).toBe(model);
});
test("reasoning CLI/profile override and resume round trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"zhx-reasoning-"));
  try {
    const context = {env:{ZHIVEX_HARNESS_CONFIG_DIR:root}};
    await createCliProfile("test",{provider:"qwen",model:"qwen3.8-flash",reasoningEffort:"low"},context);
    expect((await applyCliProfile<import("../src/runtime/config.js").HarnessConfigInput & {profile:string}>({profile:"test"},context)).reasoningEffort).toBe("low");
    expect((await applyCliProfile({profile:"test",reasoningEffort:"high" as const},context)).reasoningEffort).toBe("high");
    const parsed = parseCliArgs(["run","fix","--reasoning","low"]);
    expect(parsed.reasoningEffort).toBe("low");
    expect(harnessConfigInput(resolveHarnessConfig({...parsed,workspace:root})).reasoningEffort).toBe("low");
  } finally { await rm(root,{recursive:true,force:true}); }
});
