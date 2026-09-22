import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { wrapLanguageModel } from "@zhivex-ai/core";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { createEditProposal } from "../src/workspace/edit-contracts.js";
import { projectState } from "../scripts/swebench/telemetry.js";
import type { HarnessOciRuntimeAdapter, OciRunRequest, HarnessExecutionSession } from "../src/execution/execution-environment.js";

// Exercise the real approval, journal, snapshot and terminal-receipt paths.
// Only the OCI process result is simulated.
for (const scenario of ["corrected", "repair-corrected", "exhausted", "resumed-exhausted", "disabled", "timeout", "cancelled", "output-limit"] as const) {
  test(`terminal verifier recovery: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhx-terminal-recovery-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      await writeFile(path.join(root, "value.txt"), "before\n");
      let executions = 0;
      const runtime: HarnessOciRuntimeAdapter = {
        async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference,
          imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
        async run(request: OciRunRequest) {
          executions++;
          expect(request.command).toEqual(["node", executions === 1 ? "verify.mjs" : "verify-corrected.mjs"]);
          expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
          return { command: request.command, exitCode: (scenario === "corrected" || scenario === "repair-corrected") && executions === 2 ? 0 : 4,
            stdout: "", stderr: "private fixture failure", timedOut: scenario === "timeout",
            cancelled: scenario === "cancelled", outputLimitExceeded: scenario === "output-limit" };
        },
        async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
      };
      const inputs = [0, 1, 2].map((attempt) => ({ patchId: `sha256:${"0".repeat(64)}`, command: "node",
        args: [attempt === 0 ? "verify.mjs" : "verify-corrected.mjs"] }));
      const model = createMockLanguageModel({ streamEvents: inputs.map((input, i) => [
        { type: "tool-call" as const, toolCall: { id: `verify-${i}`, name: "verify_and_apply_environment_patch", input } },
        { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      ]) });
      const store = createInMemoryAgentRunStore();
      let recoveryFeedbackReachedModel = false;
      const observedModel = wrapLanguageModel(model, [{ wrapStream: async (context, next) => {
        recoveryFeedbackReachedModel ||= context.input.messages.some(message => message.parts.some(part =>
          part.type === "tool-result" && part.toolResult.isError === true &&
          JSON.stringify(part.toolResult.output).includes("private fixture failure")
        ));
        return next();
      } }]);
      harness = await createHarness({ workspace: root, executionBackend: "oci", provider: "openai",
        modelInstance: observedModel, store, ociRuntimeAdapter: runtime, ociAllowedCommands: ["node", "bun"], maxSteps: 5, agentProfile: scenario === "repair-corrected" ? "repair" : "strict" });
      const session = await harness.executionEnvironment!.acquire({ runId: "recovery" }) as HarnessExecutionSession;
      const before = await session.workspace.readFile("value.txt");
      const changes = [{ path: "value.txt", expectedDigest: before.digest, content: "after\n" }];
      await session.workspace.applyPatch({ proposalId: createEditProposal({ changes }).proposalId, changes });
      const patch = await session.inspectPatch();
      for (const input of inputs) input.patchId = patch.patchId;
      const approvals: string[] = [];
      const options = {
        ...(scenario === "repair-corrected" ? {} : { terminalReceiptTools: ["verify_and_apply_environment_patch"] }),
        ...(scenario === "disabled" ? {} : { maxTerminalVerificationRetries: 1 }),
        resolveApprovals: async (pending: readonly import("@zhivex-ai/agents").AgentApprovalRequest[]) => {
          if (scenario === "resumed-exhausted" && approvals.length === 1) return undefined;
          return pending.map((approval) => {
            approvals.push(approval.id);
            return { provider: approval.provider, approvalRequestId: approval.id, approve: true };
          });
        }
      };
      const result = runHarness(harness, { runId: "recovery", prompt: "Verify the patch. Correct a failed verifier before retrying." }, options);
      if ((scenario === "corrected" || scenario === "repair-corrected")) {
        const completed = await result;
        expect(completed.status).toBe("completed");
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after\n");
        expect(executions).toBe(2);
        expect(recoveryFeedbackReachedModel).toBe(true);
        expect(new Set(approvals).size).toBe(2);
        const failed = completed.toolResults.find((r) => r.isError);
        expect(failed?.output).toMatchObject({ kind: "terminal-verification-failure", verification: { exitCode: 4 } });
        // Approved command output is bounded feedback for the repair model;
        // exception messages and external telemetry must still omit its text.
        expect(failed?.output).toMatchObject({ verification: { diagnostics: {
          source: "untrusted-verifier-output", stderr: "private fixture failure", truncated: false
        } } });
        expect(JSON.stringify(failed?.error)).not.toContain("private fixture failure");
        expect(JSON.stringify(projectState(completed.state, new Map()))).not.toContain("private fixture failure");
        expect(completed.usage?.inputTokens).toBe(20);
      } else if (scenario === "resumed-exhausted") {
        const pending = await result;
        expect(pending.status).toBe("waiting_approval");
        const saved = await store.load(pending.state.runId);
        expect(saved!.toolResults.filter((r) => r.isError)).toHaveLength(1);
        await expect(runHarness(harness, { state: saved! }, { ...options,
          resolveApprovals: async (items) => items.map((item) => ({ provider: item.provider, approvalRequestId: item.id, approve: true }))
        })).rejects.toThrow("verifier failed");
        expect(executions).toBe(2);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
      } else {
        await expect(result).rejects.toThrow("verifier failed");
        expect(executions).toBe(scenario === "exhausted" ? 2 : 1);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
      }
    } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
