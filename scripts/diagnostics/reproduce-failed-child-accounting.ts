// Offline diagnostic, not a regression asserting that the defect is desirable.
// Run with: bun run scripts/diagnostics/reproduce-failed-child-accounting.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { getAgentBudgetStatus, type AgentRunState } from "@zhivex-ai/agents";
import { createHarness, runHarness } from "../../src/runtime/harness.js";
import { sanitizeOperationalError } from "../release-diagnostics.js";

for (const ledger of [false, true]) {
  const root = await mkdtemp(join(tmpdir(), "zhx-child-accounting-"));
  const store = createInMemoryAgentRunStore();
  const snapshots: AgentRunState[] = [];
  const save = store.save.bind(store);
  store.save = async (state, options) => {
    snapshots.push(structuredClone(state));
    return save(state, options);
  };
  const parent = createMockLanguageModel({
    provider: "mock-parent", modelId: "parent",
    streamEvents: [[
      { type: "tool-call", toolCall: {
        id: "delegate-1", name: "delegate_reviewer", input: { prompt: "Inspect fixture" }
      } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    ]]
  });
  const child = createMockLanguageModel({
    provider: "mock-child", modelId: "child",
    responses: [{
      messages: [{ role: "assistant", parts: [
        { type: "tool-call", toolCall: { id: "read-1", name: "list_files", input: {} } },
        { type: "tool-call", toolCall: { id: "read-2", name: "git_diff", input: {} } }
      ] }],
      text: "", finishReason: "tool-calls", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    }]
  });
  const harness = await createHarness({
    provider: "qwen", workspace: root, modelInstance: parent,
    subagentModels: { reviewer: child }, subagentProfiles: ["reviewer"],
    subagentMaxToolCalls: 1, store, env: {},
    ...(ledger ? { usageAccounting: {} } : {})
  });
  try {
    let error;
    try {
      await runHarness(harness, { runId: "fixture-parent", prompt: "Delegate", scope: harness.config.scope });
    } catch (cause) {
      error = sanitizeOperationalError(cause);
    }
    const p = await store.load("fixture-parent", harness.config.scope);
    const c = snapshots.filter(state => state.parentRunId === "fixture-parent").at(-1);
    if (!p || !c) throw new Error("Synthetic fixture did not persist both runs.");
    const aggregate = getAgentBudgetStatus(p, harness.config.budget).consumption.totalTokens;
    const combined = (p.usage?.totalTokens ?? 0) + (c.usage?.totalTokens ?? 0);
    console.log(JSON.stringify({
      ledger, error, parentStatus: p.status, childStatus: c.status,
      parentChildLinks: p.childRuns?.length ?? 0, childHasParentLink: c.parentRunId === p.runId,
      parentAggregateTokens: aggregate, reportedCombinedTokens: combined,
      childExecutedTools: c.toolResults.length,
      accountingDefectObserved: aggregate !== combined,
      ...(ledger ? { ledgerTokens: harness.usageLedger?.summary(p.runId) } : {})
    }));
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
}
