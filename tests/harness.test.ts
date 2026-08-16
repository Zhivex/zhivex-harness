import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import { createHarness, runHarness } from "../src/harness.js";

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
      for (const name of ["write_file", "replace_in_file", "run_check"]) {
        expect(tools[name]).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
      }
      for (const name of ["list_files", "read_file", "search_files", "git_diff"]) {
        expect(tools[name]?.requiresApproval).not.toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pauses before a write and resumes the same run after approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-approval-"));
    try {
      const model = createMockLanguageModel({
        provider: "mock-provider",
        modelId: "mock-model",
        streamEvents: [
          [
            {
              type: "tool-call",
              toolCall: {
                id: "write-1",
                name: "write_file",
                input: { path: "approved.txt", content: "approved\n", overwrite: false }
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
