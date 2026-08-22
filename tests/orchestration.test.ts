import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { getAgentBudgetStatus } from "@zhivex-ai/agents";

import { createEditProposal } from "../src/edit-contracts.js";
import { createHarness, runHarness } from "../src/harness.js";
import { cancelHarnessRun, inspectHarnessRun } from "../src/operations.js";
import { runHarnessReviewGroup } from "../src/orchestration.js";

const approveAll = (approvals: readonly { provider: string; id: string }[]) => approvals.map((approval) => ({
  provider: approval.provider,
  approvalRequestId: approval.id,
  approve: true,
  reason: "Orchestration test approval."
}));

describe("bounded orchestration", () => {
  test("exposes four named profiles with independent child budgets", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-subagents-"));
    try {
      const harness = await createHarness({
        provider: "openai",
        workspace,
        modelInstance: createMockLanguageModel(),
        store: createInMemoryAgentRunStore(),
        subagentMaxSteps: 5,
        subagentMaxToolCalls: 7
      });
      expect([...harness.subagents.keys()]).toEqual(["explorer", "implementer", "tester", "reviewer"]);
      expect(harness.agent.subagents?.map((profile) => profile.name)).toEqual([
        "delegate_explorer",
        "delegate_implementer",
        "delegate_tester",
        "delegate_reviewer"
      ]);
      expect(harness.agent.subagents?.every((profile) => profile.maxSteps === 5)).toBe(true);
      expect(harness.config.orchestration.childBudget).toMatchObject({
        maxSteps: 5,
        maxToolCalls: 7,
        includeChildRuns: false
      });
      const alternate = await createHarness({
        provider: "openai",
        workspace,
        modelInstance: createMockLanguageModel(),
        subagentModels: {
          explorer: createMockLanguageModel({ provider: "alternate", modelId: "child-v2" })
        },
        subagentProfiles: ["explorer"],
        store: createInMemoryAgentRunStore()
      });
      expect(alternate.agent.harness?.fingerprint).not.toBe(harness.agent.harness?.fingerprint);
      expect(alternate.subagents.get("explorer")?.harness?.fingerprint)
        .not.toBe(harness.subagents.get("explorer")?.harness?.fingerprint);
      await alternate.close();
      await harness.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("records a delegated child and aggregates its usage into the parent run", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-delegation-"));
    try {
      const store = createInMemoryAgentRunStore();
      const parentModel = createMockLanguageModel({
        provider: "mock-parent",
        modelId: "parent",
        streamEvents: [
          [
            { type: "tool-call", toolCall: { id: "delegate-1", name: "delegate_explorer", input: { prompt: "Inspect the boundary" } } },
            { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
          ],
          [
            { type: "text-delta", textDelta: "parent complete" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }
          ]
        ]
      });
      const explorerModel = createMockLanguageModel({
        provider: "mock-child",
        modelId: "explorer",
        responses: [{
          messages: [{ role: "assistant", parts: [{ type: "text", text: "child evidence" }] }],
          text: "child evidence",
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
        }]
      });
      const harness = await createHarness({
        provider: "openai",
        workspace,
        modelInstance: parentModel,
        subagentModels: { explorer: explorerModel },
        subagentProfiles: ["explorer"],
        store
      });
      const output = await runHarness(harness, {
        runId: "parent-delegation",
        prompt: "Delegate an inspection",
        scope: harness.config.scope
      });
      expect(output.status).toBe("completed");
      expect(output.state.childRuns).toHaveLength(1);
      expect(output.state.childRuns?.[0]).toMatchObject({
        agentId: "zhivex-harness-explorer",
        status: "completed",
        outputText: "child evidence"
      });
      expect(output.state.childRuns?.[0]?.usage?.totalTokens).toBe(5);
      expect(getAgentBudgetStatus(output.state, harness.config.budget).consumption.totalTokens).toBe(12);
      expect(await store.load(output.state.childRuns![0]!.runId, harness.config.scope)).toMatchObject({
        parentRunId: "parent-delegation",
        status: "completed"
      });
      const inspection = await inspectHarnessRun(store, harness.config, output.state.runId);
      expect(JSON.stringify(inspection.hierarchy)).toContain(output.state.childRuns![0]!.runId);
      await harness.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("promotes a child mutation approval and resumes the same child exactly once", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-subapproval-"));
    try {
      const store = createInMemoryAgentRunStore();
      const changes = [{ path: "child.txt", expectedDigest: null, content: "child-approved\n" }];
      const proposal = createEditProposal({ changes });
      const parentModel = createMockLanguageModel({
        provider: "mock-parent",
        modelId: "parent",
        streamEvents: [
          [
            { type: "tool-call", toolCall: { id: "delegate-write", name: "delegate_implementer", input: { prompt: "Create child.txt" } } },
            { type: "finish", finishReason: "tool-calls" }
          ],
          [
            { type: "text-delta", textDelta: "delegation complete" },
            { type: "finish", finishReason: "stop" }
          ]
        ]
      });
      const implementerModel = createMockLanguageModel({
        provider: "mock-child",
        modelId: "implementer",
        responses: [
          {
            messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "child-propose", name: "propose_edits", input: { changes } } }] }],
            finishReason: "tool-calls"
          },
          {
            messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "child-apply", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } }] }],
            finishReason: "tool-calls"
          },
          {
            messages: [{ role: "assistant", parts: [{ type: "text", text: "child complete" }] }],
            text: "child complete",
            finishReason: "stop"
          }
        ]
      });
      const harness = await createHarness({
        provider: "openai",
        workspace,
        modelInstance: parentModel,
        subagentModels: { implementer: implementerModel },
        subagentProfiles: ["implementer"],
        store
      });
      const waiting = await runHarness(harness, {
        runId: "parent-subapproval",
        prompt: "Delegate a bounded edit",
        scope: harness.config.scope
      });
      expect(waiting.status).toBe("waiting_approval");
      expect(waiting.state.pendingApprovals).toHaveLength(1);
      expect(waiting.state.pendingApprovals[0]).toMatchObject({
        kind: "subagent",
        childAgentId: "zhivex-harness-implementer"
      });
      await expect(readFile(path.join(workspace, "child.txt"), "utf8")).rejects.toThrow();

      const completed = await runHarness(harness, {
        state: waiting.state,
        approvals: approveAll(waiting.state.pendingApprovals)
      });
      expect(completed.status).toBe("completed");
      expect(await readFile(path.join(workspace, "child.txt"), "utf8")).toBe("child-approved\n");
      const child = completed.state.childRuns?.[0];
      expect(child).toMatchObject({ status: "completed", agentId: "zhivex-harness-implementer" });
      const journal = child
        ? await store.listToolCalls?.(child.runId, harness.config.scope) ?? []
        : [];
      expect(journal.filter((entry) => entry.toolName === "apply_patch" && entry.status === "completed"))
        .toHaveLength(1);
      await harness.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("cascades final cancellation from a waiting parent to its durable child", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-subcancel-"));
    try {
      const store = createInMemoryAgentRunStore();
      const changes = [{ path: "cancelled.txt", expectedDigest: null, content: "never\n" }];
      const proposal = createEditProposal({ changes });
      const harness = await createHarness({
        provider: "openai",
        workspace,
        modelInstance: createMockLanguageModel({
          streamEvents: [[
            { type: "tool-call", toolCall: { id: "cancel-delegate", name: "delegate_implementer", input: { prompt: "Create cancelled.txt" } } },
            { type: "finish", finishReason: "tool-calls" }
          ]]
        }),
        subagentModels: {
          implementer: createMockLanguageModel({
            responses: [
              {
                messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "cancel-propose", name: "propose_edits", input: { changes } } }] }],
                finishReason: "tool-calls"
              },
              {
                messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "cancel-apply", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } }] }],
                finishReason: "tool-calls"
              }
            ]
          })
        },
        subagentProfiles: ["implementer"],
        store
      });
      const waiting = await runHarness(harness, {
        runId: "parent-cancel",
        prompt: "Delegate then cancel",
        scope: harness.config.scope
      });
      const cancelled = await cancelHarnessRun(store, harness.config, waiting.state.runId, {
        cascade: true,
        final: true,
        reason: "operator cancelled tree"
      });
      expect(cancelled).toMatchObject({
        cascade: true,
        parent: { status: "cancelled" },
        children: [{ status: "cancelled" }]
      });
      await expect(readFile(path.join(workspace, "cancelled.txt"), "utf8")).rejects.toThrow();
      await harness.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("runs deterministic application-owned read-only review groups", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-review-group-"));
    try {
      const harness = await createHarness({
        provider: "openai",
        workspace,
        modelInstance: createMockLanguageModel(),
        subagentProfiles: ["explorer", "reviewer"],
        subagentModels: {
          explorer: createMockLanguageModel({ streamEvents: [[
            { type: "finish", finishReason: "stop" }
          ]], responses: [{
            messages: [{ role: "assistant", parts: [{ type: "text", text: "explorer evidence" }] }],
            text: "explorer evidence",
            finishReason: "stop"
          }] }),
          reviewer: createMockLanguageModel({ responses: [{
            messages: [{ role: "assistant", parts: [{ type: "text", text: "reviewer evidence" }] }],
            text: "reviewer evidence",
            finishReason: "stop"
          }] })
        },
        store: createInMemoryAgentRunStore()
      });
      const result = await runHarnessReviewGroup(harness, {
        groupId: "review-group-1",
        prompt: "Review independently",
        scope: harness.config.scope
      });
      expect(result).toMatchObject({
        schemaVersion: 1,
        kind: "review-group",
        groupId: "review-group-1",
        status: "completed",
        profiles: ["explorer", "reviewer"]
      });
      expect(result.outputs.map((output) => output.output?.outputText)).toEqual([
        "explorer evidence",
        "reviewer evidence"
      ]);
      await expect(runHarnessReviewGroup(harness, {
        prompt: "unsafe group",
        scope: harness.config.scope
      }, ["implementer"])).rejects.toThrow("read-only");
      await harness.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
