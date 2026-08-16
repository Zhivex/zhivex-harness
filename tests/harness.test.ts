import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import { createHarness, runHarness } from "../src/harness.js";
import { createEditProposal } from "../src/edit-contracts.js";

describe("Zhivex harness", () => {
  test("runs the shared agent loop with an injected model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-agent-"));
    try {
      const model = createMockLanguageModel({
        provider: "mock-provider",
        modelId: "mock-model",
        streamEvents: [[
          { type: "text-delta", textDelta: "Done" },
          { type: "finish", finishReason: "stop" }
        ]]
      });
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: model,
        store: createInMemoryAgentRunStore()
      });
      const deltas: string[] = [];
      const result = await runHarness(harness, { prompt: "Reply with done" }, {
        onEvent: (event) => {
          if (event.type === "text-delta") {
            deltas.push(event.textDelta);
          }
        }
      });

      expect(result.status).toBe("completed");
      expect(result.outputText).toBe("Done");
      expect(deltas).toEqual(["Done"]);
      expect(result.state.provider).toBe("mock-provider");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks every mutating or execution tool for interrupt approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-tools-"));
    try {
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: createMockLanguageModel(),
        store: createInMemoryAgentRunStore()
      });
      const tools = harness.agent.tools as Record<string, { requiresApproval?: boolean; approvalMode?: string }>;
      for (const name of ["apply_patch", "move_file", "quarantine_file", "restore_file", "run_check"]) {
        expect(tools[name]).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
      }
      for (const name of ["list_files", "read_file", "search_files", "propose_edits", "mutation_audit", "git_diff"]) {
        expect(tools[name]?.requiresApproval).not.toBe(true);
      }
      expect(tools.write_file).toBeUndefined();
      expect(tools.replace_in_file).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("proposes edits only against currently inspected digests without mutating files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-proposal-"));
    try {
      await writeFile(path.join(root, "existing.txt"), "current\n", "utf8");
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: createMockLanguageModel(),
        store: createInMemoryAgentRunStore()
      });
      const inspected = await harness.workspace.readFile("existing.txt");
      const propose = (harness.agent.tools as Record<string, {
        execute: (input: unknown) => Promise<unknown>;
      }>).propose_edits;
      if (!propose) {
        throw new Error("propose_edits tool is missing");
      }
      const changes = [{
        path: "existing.txt",
        expectedDigest: inspected.digest,
        content: "proposed\n"
      }];

      await expect(propose.execute({ changes })).resolves.toMatchObject({
        schemaVersion: 1,
        kind: "edit-proposal",
        proposalId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      });
      await expect(propose.execute({
        changes: [{ ...changes[0], expectedDigest: `sha256:${"0".repeat(64)}` }]
      })).rejects.toThrow("expectedDigest does not match");
      expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("current\n");
      expect(harness.workspace.mutationAudit()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pauses before a write and resumes the same run after approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-approval-"));
    try {
      const changes = [{ path: "approved.txt", expectedDigest: null, content: "approved\n" }];
      const proposal = createEditProposal({ changes });
      const model = createMockLanguageModel({
        provider: "mock-provider",
        modelId: "mock-model",
        streamEvents: [
          [
            {
              type: "tool-call",
              toolCall: {
                id: "proposal-1",
                name: "propose_edits",
                input: { changes }
              }
            },
            { type: "finish", finishReason: "tool-calls" }
          ],
          [
            {
              type: "tool-call",
              toolCall: {
                id: "apply-1",
                name: "apply_patch",
                input: { proposalId: proposal.proposalId, changes }
              }
            },
            { type: "finish", finishReason: "tool-calls" }
          ],
          [
            { type: "text-delta", textDelta: "File created" },
            { type: "finish", finishReason: "stop" }
          ]
        ]
      });
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: model,
        store: createInMemoryAgentRunStore()
      });
      let approvalObserved = false;
      const result = await runHarness(harness, { prompt: "Create approved.txt" }, {
        resolveApprovals: async (approvals) => {
          approvalObserved = true;
          await expect(readFile(path.join(root, "approved.txt"), "utf8")).rejects.toThrow();
          return approvals.map((approval) => ({
            provider: approval.provider,
            approvalRequestId: approval.id,
            approve: true
          }));
        }
      });

      expect(approvalObserved).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.outputText).toBe("File created");
      expect(await readFile(path.join(root, "approved.txt"), "utf8")).toBe("approved\n");
      expect(harness.workspace.mutationAudit()).toContainEqual(expect.objectContaining({
        operation: "create",
        path: "approved.txt",
        afterDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
