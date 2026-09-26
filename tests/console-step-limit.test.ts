import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { consoleBudgetOptions } from "../src/cli/console/console-budget.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { formatTerminalEvent } from "../src/cli/terminal/terminal-ui.js";

for (const mode of ["api", "interactive", "explicit12"] as const) test(`long task with ${mode} limits`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-steps-"));
  await Promise.all(Array.from({length:13}, (_,i) => writeFile(path.join(root, `file-${i}.txt`), `Evidence ${i}`)));
  const model = createMockLanguageModel({streamEvents:[
    ...Array.from({length:13},(_,i)=>[
      {type:"tool-call" as const,toolCall:{id:`read-${i}`,name:"read_file",input:{path:`file-${i}.txt`}}},
      {type:"finish" as const,finishReason:"tool-calls" as const}
    ]),
    [{type:"text-delta",textDelta:"Inspection complete."},{type:"finish",finishReason:"stop"}]
  ]});
  const options = mode === "interactive" ? consoleBudgetOptions(parseCliArgs(["chat"]),{}) : mode === "explicit12" ? {maxSteps:12} : {};
  const harness = await createHarness({...options,workspace:root,provider:"qwen",model:"qwen3.8-flash",modelInstance:model,store:createInMemoryAgentRunStore(),subagentProfiles:[]});
  try {
    const result = await runHarness(harness,{prompt:"Inspect the project."});
    expect(result.status).toBe(mode === "explicit12" ? "failed" : "completed");
    if (mode !== "explicit12") expect(result.outputText).toContain("Inspection complete");
    else expect(formatTerminalEvent({type:"agent-run-finish",status:result.status,state:result.state} as never)).toContain("12/12");
  } finally { await harness.close(); await rm(root,{recursive:true,force:true}); }
});

test("explicit CLI and API counts can exceed former arbitrary ceilings", async () => {
  const { resolveHarnessConfig } = await import("../src/runtime/config.js");
  const options = parseCliArgs(["run", "task", "--max-steps", "1000", "--max-tool-calls", "1001",
    "--subagent-max-steps", "100", "--subagent-max-tool-calls", "501"]);
  const config = resolveHarnessConfig(options);
  expect(config.maxSteps).toBe(1000);
  expect(config.budget.maxToolCalls).toBe(1001);
  expect(config.orchestration.childBudget.maxSteps).toBe(100);
  expect(config.orchestration.childBudget.maxToolCalls).toBe(501);
  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) {
    for (const key of ["maxSteps", "maxToolCalls", "subagentMaxSteps", "subagentMaxToolCalls"] as const) {
      expect(() => resolveHarnessConfig({ [key]: value })).toThrow(key);
    }
    expect(() => parseCliArgs(["run", "task", "--max-steps", String(value)])).toThrow();
  }
  expect(() => resolveHarnessConfig({maxSteps:0})).toThrow("maxSteps");
  expect(() => resolveHarnessConfig({subagentMaxSteps:0})).toThrow("subagentMaxSteps");
  expect(resolveHarnessConfig({maxToolCalls:0,subagentMaxToolCalls:0}).budget.maxToolCalls).toBe(0);
});
