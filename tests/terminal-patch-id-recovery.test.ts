import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { wrapLanguageModel } from "@zhivex-ai/core";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import type { HarnessExecutionSession, HarnessOciRuntimeAdapter } from "../src/execution/execution-environment.js";

for (const scenario of ["corrected", "exhausted", "resumed-exhausted", "snapshot-changed", "new-approval-pending"] as const) {
  test(`terminal patch ID recovery: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhx-id-recovery-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      await writeFile(path.join(root, "value.txt"), "before\n");
      const runtime: HarnessOciRuntimeAdapter = {
        async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference,
          imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
        async run() { throw new Error("No process execution is needed for this import regression"); },
        async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
      };
      const wrongId = `sha256:${"0".repeat(64)}`;
      const first = { patchId: wrongId }, second = { patchId: wrongId };
      const calls = [
        { id: "bad-import", name: "apply_environment_patch", input: first },
        { id: "reinspect", name: "inspect_environment_patch", input: {} },
        { id: "new-import", name: "apply_environment_patch", input: second }
      ];
      let feedback = false;
      const model = wrapLanguageModel(createMockLanguageModel({ streamEvents: calls.map(toolCall => [
        { type: "tool-call" as const, toolCall },
        { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      ]) }), [{ wrapStream: async (context, next) => {
        feedback ||= context.input.messages.some(message => message.parts.some(part =>
          part.type === "tool-result" && part.toolResult.isError &&
          JSON.stringify(part.toolResult.output).includes("terminal-patch-id-mismatch")));
        return next();
      } }]);
      const store = createInMemoryAgentRunStore();
      harness = await createHarness({ workspace: root, executionBackend: "oci", provider: "openai", modelInstance: model,
        store, ociRuntimeAdapter: runtime, maxSteps: 8 });
      const session = await harness.executionEnvironment!.acquire({ runId: "id-recovery" }) as HarnessExecutionSession;
      await writeFile(path.join(session.workspace.root, "value.txt"), "after\n");
      const patch = await session.inspectPatch();
      if (scenario === "corrected" || scenario === "new-approval-pending") second.patchId = patch.patchId;
      if (scenario === "snapshot-changed") {
        first.patchId = patch.patchId;
        await writeFile(path.join(session.workspace.root, "value.txt"), "different\n");
      }
      await session.release?.({ status: "waiting_approval" });
      const approvals: string[] = [];
      const result = runHarness(harness, { runId: "id-recovery", prompt: "Import only the reviewed patch." }, {
        terminalReceiptTools: ["apply_environment_patch"],
        resolveApprovals: async pending => {
          expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
          if (approvals.length === 1 && (scenario === "resumed-exhausted" || scenario === "new-approval-pending")) return undefined;
          return pending.map(approval => {
            approvals.push(approval.id);
            return { provider: approval.provider, approvalRequestId: approval.id, approve: true };
          });
        }
      });
      if (scenario === "corrected") {
        const output = await result;
        expect(output.status).toBe("completed");
        expect(feedback).toBe(true);
        expect(new Set(approvals).size).toBe(2);
        expect(output.toolResults.filter(item => item.isError)).toHaveLength(1);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after\n");
      } else if (scenario === "resumed-exhausted" || scenario === "new-approval-pending") {
        const output = await result;
        expect(output.status).toBe("waiting_approval");
        expect(feedback).toBe(true);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
        const state = await store.load("id-recovery");
        expect(state!.toolResults.some(item => item.isError && JSON.stringify(item.output).includes("terminal-patch-id-mismatch"))).toBe(true);
        if (scenario === "resumed-exhausted") await expect(runHarness(harness, { state: state! }, {
          terminalReceiptTools: ["apply_environment_patch"], resolveApprovals: async items => items.map(item => ({
            provider: item.provider, approvalRequestId: item.id, approve: true
          }))
        })).rejects.toThrow("changed after review");
      } else {
        await expect(result).rejects.toThrow("changed after review");
        expect(approvals.length).toBe(scenario === "exhausted" ? 2 : 1);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
      }
    } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
