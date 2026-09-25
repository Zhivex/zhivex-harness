import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { terminalRunFailure } from "../src/cli/terminal/terminal-ui.js";

for (const approval of [false, true]) test(`long event stream retains every live delta${approval ? " after approval" : ""}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stream-retention-"));
  const chunks = Array.from({length: 4300}, (_, i) => `${i},`);
  const model = createMockLanguageModel({streamEvents:[
    ...(approval ? [[{type:"tool-call" as const,toolCall:{id:"edit",name:"apply_reviewed_edits",input:{changes:[{path:"result.txt",expectedDigest:null,content:"approved"}]}}},
      {type:"finish" as const,finishReason:"tool-calls" as const}]] : []),
    [...chunks.map(textDelta => ({type:"text-delta" as const,textDelta})), {type:"finish",finishReason:"stop"}]
  ]});
  const store = createInMemoryAgentRunStore();
  const harness = await createHarness({workspace:root,provider:"qwen",model:"qwen3.8-flash",modelInstance:model,store,subagentProfiles:[],unlimitedTokens:true});
  let received = "", decisions = 0, finished = false;
  try {
    const result = await runHarness(harness, {prompt:"Complete the task.",
      ...(approval ? {streamBuffer:{maxHistory:32}} : {})}, {
      onEvent: async event => {
        if (event.type === "text-delta") {
          received += event.textDelta;
          if (received.length % 127 === 0) await new Promise(resolve => setTimeout(resolve, 1));
        }
        if (event.type === "agent-run-finish" && event.status === "completed") finished = true;
      },
      resolveApprovals: async approvals => {
        decisions++;
        return approvals.map(a => ({provider:a.provider,approvalRequestId:a.id,approve:true}));
      }
    });
    expect(result.status).toBe("completed");
    expect(received).toBe(chunks.join(""));
    expect(result.outputText).toBe(received);
    expect((await store.load(result.state.runId, result.state.scope))?.outputText).toBe(received);
    expect(finished).toBe(true);
    expect(decisions).toBe(approval ? 1 : 0);
  } finally { await harness.close(); await rm(root,{recursive:true,force:true}); }
}, 15000);

test("replay overflow diagnostics expose only the bounded event count", () => {
  expect(terminalRunFailure(new Error("Stream replay buffer exceeded its limit of 4096 events."))).toBe("event replay limit reached · 4096 events");
  expect(terminalRunFailure(new Error("Stream replay buffer SECRET"))).not.toContain("SECRET");
});
