import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { createEditProposal } from "../src/workspace/edit-contracts.js";

for (const provider of ["meta", "openai"] as const) {
  for (const outputLimit of [4, 2]) {
    test(`${provider} recalculates output caps and stops at ${outputLimit} tokens`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "token-cap-"));
      const caps: (number | undefined)[] = [];
      const model = createMockLanguageModel({ streamEvents: [
        [{ type: "tool-call", toolCall: { id: "list", name: "list_files", input: {} } },
          { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
        [{ type: "text-delta", textDelta: "done" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }]
      ] });
      const stream = model.stream!;
      model.stream = input => { caps.push(input.maxTokens); return stream(input); };
      const harness = await createHarness({ workspace: root, provider, modelInstance: model,
        store: createInMemoryAgentRunStore(), subagentProfiles: [], maxOutputTokens: outputLimit });
      try {
        let failed = false;
        try { const result = await runHarness(harness, { prompt: "List then finish." });
          failed = result.status === "failed";
          if (outputLimit === 4) expect(result.outputText).toBe("done");
        } catch (error) { failed = true; expect(String(error)).toContain("maxOutputTokens"); }
        expect(failed).toBe(outputLimit === 2);
        expect(caps).toEqual(outputLimit === 4 ? [4, 2] : [2]);
      } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
  test(`${provider} preserves consumed tokens across approval resume`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "token-cap-resume-"));
    const changes = [{ path: "created.txt", expectedDigest: null, content: "approved" }];
    const proposal = createEditProposal({ changes });
    const caps: (number | undefined)[] = [];
    const model = createMockLanguageModel({ streamEvents: [
      [{ type: "tool-call", toolCall: { id: "edit", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
      [{ type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }]
    ] });
    const stream = model.stream!;
    model.stream = input => { caps.push(input.maxTokens); return stream(input); };
    const harness = await createHarness({ workspace: root, provider, modelInstance: model,
      store: createInMemoryAgentRunStore(), subagentProfiles: [], maxOutputTokens: 8 });
    try {
      const waiting = await runHarness(harness, { prompt: "Create then finish.", maxTokens: 5 });
      expect(waiting.status).toBe("waiting_approval");
      const result = await runHarness(harness, { state: waiting.state, maxTokens: 7,
        approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
      expect(result.status).toBe("completed");
      expect(result.usage?.outputTokens).toBe(4);
      expect(caps).toEqual([5, 6]);
    } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("an over-budget response cannot execute its requested tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-cap-overrun-"));
  const store = createInMemoryAgentRunStore();
  const harness = await createHarness({ workspace: root, provider: "openai", store,
    subagentProfiles: [], maxOutputTokens: 2,
    modelInstance: createMockLanguageModel({ streamEvents: [[
      { type: "tool-call", toolCall: { id: "over", name: "list_files", input: {} } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 } }
    ]] }) });
  try {
    await expect(runHarness(harness, { runId: "overrun", prompt: "List." })).rejects.toThrow("maxOutputTokens");
    expect((await store.load("overrun"))?.toolResults).toEqual([]);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
