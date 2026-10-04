import { appendFile, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness } from "../../src/runtime/harness.js";
import { runHarnessDurableReviewGroup } from "../../src/runtime/durable-review-group.js";

const workspace = process.argv[2]!;
const models = Object.fromEntries((["explorer", "reviewer"] as const).map(role => {
  const model = createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: [{ type: "text", text: `${role} evidence` }] }],
    text: `${role} evidence`, finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }] });
  const generate = model.generate;
  model.generate = async input => {
    await appendFile(path.join(workspace, "calls.txt"), `${role}\n`);
    if (role === "explorer") {
      await writeFile(path.join(workspace, "entered"), "ready");
      while (!input.abortSignal?.aborted) {
        try { await access(path.join(workspace, "release")); break; } catch { await new Promise(r => setTimeout(r, 10)); }
      }
    }
    return generate(input);
  };
  return [role, model];
}));
const harness = await createHarness({ provider: "openai", workspace, modelInstance: createMockLanguageModel(), subagentModels: models });
if (process.argv[3] === "crash-after-children") {
  const save = harness.store.save.bind(harness.store);
  harness.store.save = async (state, options) => {
    if (state.runId === "worker-group") {
      const record = state.metadata?.harnessReviewGroupV1 as { members: { runId: string }[] };
      const members = await Promise.all(record.members.map(m => harness.store.load(m.runId, harness.config.scope)));
      if (members.every(m => m?.status === "completed")) process.exit(77);
    }
    return save(state, options);
  };
}
try {
  console.log(JSON.stringify(await runHarnessDurableReviewGroup(harness, { groupId: "worker-group", prompt: "inspect", ...(process.argv[3] === "shared" ? { sharedBudget: { modelReservation: { inputTokens: 10_000, outputTokens: 1000, totalTokens: 11_000 } } } : {}) })));
} finally { await harness.close(); }
