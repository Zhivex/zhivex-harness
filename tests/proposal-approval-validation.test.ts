import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue, StreamEvent } from "@zhivex-ai/core";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { applyEditProposalInputSchema, createEditProposal } from "../src/workspace/edit-contracts.js";

test("proposal binding schema reports bounded issues without throwing on malformed changes", () => {
  const proposalId = `sha256:${"0".repeat(64)}`;
  const mismatch = applyEditProposalInputSchema.safeParse({ proposalId,
    changes: [{ path: "file.txt", expectedDigest: null, content: "private fixture" }] });
  expect(mismatch.success).toBe(false);
  if (!mismatch.success) {
    expect(mismatch.error.issues).toHaveLength(1);
    expect(mismatch.error.issues[0]?.path).toEqual(["proposalId"]);
    expect(mismatch.error.message).not.toContain("private fixture");
    expect(mismatch.error.message).not.toContain(proposalId);
  }
  expect(applyEditProposalInputSchema.safeParse({ proposalId,
    changes: [{ path: "../outside.txt", expectedDigest: null, content: "x" }] }).success).toBe(false);
});

for (const correctRetry of [false, true]) {
  test(`rejects mismatched proposal before approval; corrected retry=${correctRetry}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-proposal-validation-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      const changes = [{ path: "approved.txt", expectedDigest: null, content: "approved\n" }];
      const proposal = createEditProposal({ changes });
      const call = (id: string, name: string, input: JsonValue): StreamEvent[] => [
        { type: "tool-call" as const, toolCall: { id, name, input } },
        { type: "finish" as const, finishReason: "tool-calls" as const }
      ];
      const model = createMockLanguageModel({ streamEvents: [
        call("propose", "propose_edits", { changes }),
        call("invalid", "apply_patch", { proposalId: `sha256:${"0".repeat(64)}`, changes }),
        ...(correctRetry ? [call("corrected", "apply_patch", { proposalId: proposal.proposalId, changes })] : []),
        [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }]
      ] });
      harness = await createHarness({ workspace: root, modelInstance: model,
        toolNames: ["propose_edits", "apply_patch"], store: createInMemoryAgentRunStore() });
      const pending = await runHarness(harness, { prompt: "Propose and apply the file", maxSteps: 5 });
      expect(pending.toolResults.find(result => result.toolCallId === "propose")?.output).toEqual(proposal);
      expect(pending.toolResults.find(result => result.toolCallId === "invalid")).toMatchObject({
        isError: true, error: { code: "TOOL_INPUT_VALIDATION_ERROR" }
      });
      expect(harness.workspace.mutationAudit()).toHaveLength(0);
      await expect(readFile(path.join(root, "approved.txt"))).rejects.toThrow();
      if (!correctRetry) {
        expect(pending.status).toBe("completed");
        expect(pending.state.pendingApprovals).toHaveLength(0);
        return;
      }
      expect(pending.status).toBe("waiting_approval");
      expect(pending.state.pendingApprovals).toHaveLength(1);
      const approval = pending.state.pendingApprovals[0]!;
      expect(JSON.parse(approval.arguments)).toEqual({ proposalId: proposal.proposalId, changes });
      const resumed = await runHarness(harness, { state: pending.state,
        approvals: [{ provider: approval.provider, approvalRequestId: approval.id, approve: true }] });
      expect(resumed.status).toBe("completed");
      expect(await readFile(path.join(root, "approved.txt"), "utf8")).toBe("approved\n");
      expect(harness.workspace.mutationAudit().filter(entry => entry.operation === "create")).toHaveLength(1);
      expect(resumed.toolResults.filter(result => result.toolCallId === "corrected" && !result.isError)).toHaveLength(1);
    } finally {
      await harness?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
