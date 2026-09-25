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

for (const interactive of [false, true]) test(`long task ${interactive ? "completes with interactive defaults" : "reports the twelve-step boundary"}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-steps-"));
  await Promise.all(Array.from({length:13}, (_,i) => writeFile(path.join(root, `file-${i}.txt`), `Evidence ${i}`)));
  const model = createMockLanguageModel({streamEvents:[
    ...Array.from({length:13},(_,i)=>[
      {type:"tool-call" as const,toolCall:{id:`read-${i}`,name:"read_file",input:{path:`file-${i}.txt`}}},
      {type:"finish" as const,finishReason:"tool-calls" as const}
    ]),
    [{type:"text-delta",textDelta:"Inspection complete."},{type:"finish",finishReason:"stop"}]
  ]});
  const options = interactive ? consoleBudgetOptions(parseCliArgs(["chat"]),{}) : {};
  const harness = await createHarness({...options,workspace:root,provider:"qwen",model:"qwen3.8-flash",modelInstance:model,store:createInMemoryAgentRunStore(),subagentProfiles:[]});
  try {
    const result = await runHarness(harness,{prompt:"Inspect the project."});
    expect(result.status).toBe(interactive ? "completed" : "failed");
    if (interactive) expect(result.outputText).toContain("Inspection complete");
    else expect(formatTerminalEvent({type:"agent-run-finish",status:result.status,state:result.state} as never)).toContain("12/12");
  } finally { await harness.close(); await rm(root,{recursive:true,force:true}); }
});
