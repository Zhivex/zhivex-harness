import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import { compactHarnessMessages, createHarness, runHarness } from "../src/harness.js";
import { createEditProposal } from "../src/edit-contracts.js";

describe("Zhivex harness", () => {
  test("compacts an interactive conversation without retaining sensitive tool payloads", () => {
    const messages = compactHarnessMessages([
      { role: "user", parts: [{ type: "text", text: "OPENAI_API_KEY=sk-secret-value" }] },
      {
        role: "assistant",
        parts: [{
          type: "tool-call",
          toolCall: { id: "call-1", name: "read_file", input: { content: "private-input" } }
        }]
      },
      {
        role: "tool",
        parts: [{
          type: "tool-result",
          toolResult: {
            toolCallId: "call-1",
            toolName: "read_file",
            output: { content: "private-output" },
            isError: false
          }
        }]
      }
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("tool-call:read_file");
    expect(serialized).toContain("tool-result:read_file");
    expect(serialized).not.toContain("private-input");
    expect(serialized).not.toContain("private-output");
    expect(serialized).not.toContain("sk-secret-value");
  });

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

  test("binds durable resumes to a non-secret provider transport fingerprint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-transport-"));
    try {
      const model = createMockLanguageModel({ provider: "openai", modelId: "gpt-test" });
      const first = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: model,
        store: createInMemoryAgentRunStore(),
        env: { OPENAI_BASE_URL: "https://first.example.invalid/v1" }
      });
      const second = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: model,
        store: createInMemoryAgentRunStore(),
        env: { OPENAI_BASE_URL: "https://second.example.invalid/v1" }
      });
      try {
        const firstBinding = JSON.stringify(first.agent.harness);
        const secondBinding = JSON.stringify(second.agent.harness);
        expect(first.agent.harness?.fingerprint).not.toBe(second.agent.harness?.fingerprint);
        expect(firstBinding).not.toContain("first.example.invalid");
        expect(secondBinding).not.toContain("second.example.invalid");
      } finally {
        first.close();
        second.close();
      }
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

  test("preserves provider options across automatic approval continuations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-provider-options-"));
    try {
      const changes = [{ path: "continued.txt", expectedDigest: null, content: "continued\n" }];
      const proposal = createEditProposal({ changes });
      const baseModel = createMockLanguageModel({
        streamEvents: [
          [
            {
              type: "tool-call",
              toolCall: {
                id: "continued-apply",
                name: "apply_patch",
                input: { proposalId: proposal.proposalId, changes }
              }
            },
            { type: "finish", finishReason: "tool-calls" }
          ],
          [
            { type: "text-delta", textDelta: "continued" },
            { type: "finish", finishReason: "stop" }
          ]
        ]
      });
      const seen: unknown[] = [];
      const model = new Proxy(baseModel, {
        get(target, property, receiver) {
          if (property === "stream") {
            return (input: { providerOptions?: unknown }) => {
              seen.push(input.providerOptions);
              return target.stream(input as never);
            };
          }
          return Reflect.get(target, property, receiver);
        }
      });
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: model,
        store: createInMemoryAgentRunStore()
      });
      const result = await runHarness(harness, {
        prompt: "Apply the fixture",
        providerOptions: { apiMode: "responses" }
      }, {
        resolveApprovals: async (approvals) => approvals.map((approval) => ({
          provider: approval.provider,
          approvalRequestId: approval.id,
          approve: true
        }))
      });
      expect(result.status).toBe("completed");
      expect(seen).toEqual([{ apiMode: "responses" }, { apiMode: "responses" }]);
      expect(await readFile(path.join(root, "continued.txt"), "utf8")).toBe("continued\n");
      harness.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a durable resume in a different canonical workspace", async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-binding-a-"));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-binding-b-"));
    try {
      const changes = [{ path: "bound.txt", expectedDigest: null, content: "bound\n" }];
      const proposal = createEditProposal({ changes });
      const store = createInMemoryAgentRunStore();
      const first = await createHarness({
        provider: "openai",
        workspace: firstRoot,
        store,
        modelInstance: createMockLanguageModel({
          provider: "mock-provider",
          modelId: "mock-model",
          streamEvents: [[
            {
              type: "tool-call",
              toolCall: {
                id: "bound-apply",
                name: "apply_patch",
                input: { proposalId: proposal.proposalId, changes }
              }
            },
            { type: "finish", finishReason: "tool-calls" }
          ]]
        })
      });
      const waiting = await runHarness(first, { prompt: "Create a bound file" });
      expect(waiting.status).toBe("waiting_approval");

      const second = await createHarness({
        provider: "openai",
        workspace: secondRoot,
        store,
        modelInstance: createMockLanguageModel({ provider: "mock-provider", modelId: "mock-model" })
      });
      let resumeError: unknown;
      try {
        await runHarness(second, {
          state: waiting.state,
          approvals: waiting.state.pendingApprovals.map((approval) => ({
            provider: approval.provider,
            approvalRequestId: approval.id,
            approve: true
          }))
        });
      } catch (error) {
        resumeError = error;
      }
      expect(resumeError).toBeInstanceOf(Error);
      expect((resumeError as Error).message).toMatch(/harness|fingerprint|binding/i);
      await expect(readFile(path.join(secondRoot, "bound.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  test("records deterministic context compaction before the next model request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-compaction-"));
    try {
      const model = createMockLanguageModel({
        provider: "mock-provider",
        modelId: "mock-model",
        streamEvents: [
          [
            { type: "tool-call", toolCall: { id: "list-1", name: "list_files", input: { path: ".", limit: 10 } } },
            { type: "finish", finishReason: "tool-calls" }
          ],
          [
            { type: "tool-call", toolCall: { id: "list-2", name: "list_files", input: { path: ".", limit: 10 } } },
            { type: "finish", finishReason: "tool-calls" }
          ],
          [
            { type: "text-delta", textDelta: "compacted" },
            { type: "finish", finishReason: "stop" }
          ]
        ]
      });
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: model,
        store: createInMemoryAgentRunStore(),
        compactionMaxMessages: 4,
        compactionKeepRecentMessages: 2,
        compactionMaxEstimatedInputTokens: 1_000
      });
      const result = await runHarness(harness, { prompt: "Inspect twice" });
      expect(result.status).toBe("completed");
      expect(result.state.compactions).toHaveLength(1);
      expect(result.state.compactions?.[0]).toMatchObject({
        reasons: expect.arrayContaining(["message-count"]),
        metadata: { strategy: "deterministic-redacted-transcript" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed before a tool call exceeds its durable budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-budget-"));
    try {
      const store = createInMemoryAgentRunStore();
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: createMockLanguageModel({
          streamEvents: [[
            { type: "tool-call", toolCall: { id: "list-budget", name: "list_files", input: { path: ".", limit: 10 } } },
            { type: "finish", finishReason: "tool-calls" }
          ]]
        }),
        store,
        maxToolCalls: 0
      });
      await expect(runHarness(harness, { runId: "budget-run", prompt: "Inspect" })).rejects.toThrow("maxToolCalls");
      expect((await store.load("budget-run"))?.toolResults).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces Qwen token budgets without transporting an incompatible maxTokens option", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-qwen-budget-"));
    try {
      const harness = await createHarness({
        provider: "qwen",
        workspace: root,
        modelInstance: createMockLanguageModel({
          provider: "qwen",
          modelId: "qwen3.8-max",
          streamEvents: [[
            { type: "text-delta", textDelta: "over budget" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 }
            }
          ]]
        }),
        store: createInMemoryAgentRunStore(),
        maxInputTokens: 10,
        maxOutputTokens: 2,
        maxTotalTokens: 12
      });
      expect(harness.agent.policy?.budget).not.toHaveProperty("maxOutputTokens");
      expect(harness.agent.policy?.budget).not.toHaveProperty("maxTotalTokens");
      expect(harness.agent.policy?.budget).toMatchObject({ maxToolCalls: 32, maxToolErrors: 4 });
      const result = await runHarness(harness, { prompt: "Respect the budget" });
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("maxOutputTokens");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applies the optional cost ceiling to usage from the current provider step", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-cost-budget-"));
    try {
      const harness = await createHarness({
        provider: "openai",
        workspace: root,
        modelInstance: createMockLanguageModel({
          streamEvents: [[
            { type: "text-delta", textDelta: "costly" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 }
            }
          ]]
        }),
        store: createInMemoryAgentRunStore(),
        maxCostUsd: 0.001,
        inputCostPerMillion: 1_000
      });
      const result = await runHarness(harness, { prompt: "Respect the cost ceiling" });
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("cost budget exhausted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
