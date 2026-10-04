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
try {
  console.log(JSON.stringify(await runHarnessDurableReviewGroup(harness, { groupId: "worker-group", prompt: "inspect" })));
} finally { await harness.close(); }
