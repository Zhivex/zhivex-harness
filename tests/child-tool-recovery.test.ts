import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import type { GenerateResult, ToolCall } from "@zhivex-ai/core";
import { createHarness, runHarness } from "../src/runtime/harness.js";

const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const call = (id: string, name: string, input: ToolCall["input"]): GenerateResult => ({
  message: { role: "assistant", parts: [{ type: "tool-call", toolCall: { id, name, input } }] },
  finishReason: "tool-calls", usage
});
const done: GenerateResult = { message: { role: "assistant", parts: [{ type: "text", text: "Child evidence" }] },
  text: "Child evidence", finishReason: "stop", usage };

for (const scenario of ["validation", "unknown", "bounded", "approval"] as const) {
  test(`generalist delegated child tool recovery: ${scenario}`, async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "child-tool-recovery-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      await writeFile(path.join(workspace, "evidence.txt"), "Repository evidence");
      const store = createInMemoryAgentRunStore();
      const profile = scenario === "approval" ? "implementer" : "explorer";
      const bad = scenario === "validation" ? call("invalid", "read_file", { path: 12 }) : call("unknown", "unregistered_tool", {});
      const responses = scenario === "bounded" ? [bad, call("unknown2", "unregistered_tool", {}), done] : [bad,
        scenario === "approval" ? call("edit", "apply_reviewed_edits", { changes: [
          { path: "new.txt", expectedDigest: null, content: "Must wait for approval" }
        ] }) : call("read", "read_file", { path: "evidence.txt" }), done];
      harness = await createHarness({ workspace, agentProfile: "strict", store,
        subagentProfiles: [profile], subagentMaxToolErrors: scenario === "bounded" ? 1 : 4,
        modelInstance: createMockLanguageModel({ streamEvents: [[
          { type: "tool-call", toolCall: { id: "delegate", name: `delegate_${profile}`, input: { prompt: "Inspect or edit the fixture" } } },
          { type: "finish", finishReason: "tool-calls", usage }
        ], [{ type: "text-delta", textDelta: "Parent result" }, { type: "finish", finishReason: "stop", usage }]] }),
        subagentModels: { [profile]: createMockLanguageModel({ responses }) }
      });
      const pending = runHarness(harness, { runId: `child-recovery-${scenario}`, prompt: "Delegate fixture work", scope: harness.config.scope });
      if (scenario === "bounded") {
        await expect(pending).rejects.toThrow("maxToolErrors");
        const parent = await store.load(`child-recovery-${scenario}`, harness.config.scope);
        expect(parent?.status).toBe("failed");
        const childRef = parent?.childRuns?.[0];
        expect(childRef).toBeDefined();
        const child = await store.load(childRef!.runId, harness.config.scope);
        expect(child?.status).toBe("failed");
        expect(child!.steps.length).toBeLessThanOrEqual(2);
        return;
      }
      const result = await pending;
      const childRef = result.state.childRuns?.[0];
      expect(childRef).toBeDefined();
      const child = await store.load(childRef!.runId, harness.config.scope);
      expect(child).toBeDefined();
      if (scenario === "approval") {
        expect(result.status).toBe("waiting_approval");
        expect(child?.status).toBe("waiting_approval");
        await expect(readFile(path.join(workspace, "new.txt"), "utf8")).rejects.toThrow();
        expect(result.state.pendingApprovals[0]).toMatchObject({ kind: "subagent" });
      } else {
        expect(result.status).toBe("completed");
        expect(child?.status).toBe("completed");
        expect(childRef?.usage?.inputTokens).toBe(30);
        const calls = await store.listToolCalls?.(childRef!.runId, harness.config.scope) ?? [];
        expect(calls.some(entry => entry.toolName === "read_file" && entry.status === "completed")).toBe(true);
      }
    } finally { await harness?.close(); await rm(workspace, { recursive: true, force: true }); }
  });
}
