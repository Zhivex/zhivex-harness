import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { createContextRuntime, SCOPED_CONTEXT_KEY } from "../src/runtime/context-runtime.js";
import { wrapLanguageModel } from "@zhivex-ai/core";
import { createProgressMonitor, PROGRESS_MONITOR_KEY } from "../src/runtime/progress-monitor.js";

test("runtime discovers guidance after a read and refreshes edited guidance on resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scoped-runtime-"));
  await mkdir(path.join(root, "module"));
  await writeFile(path.join(root, "module/AGENTS.md"), "Use component-specific conventions.");
  await writeFile(path.join(root, "module/file.ts"), "export const x = 1;");
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "read", name: "read_file", input: { path: "module/file.ts" } } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }],
    [{ type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: {
      path: "module/file.ts", oldText: "export const x = 1;", newText: "export const x = 2;"
    } } }, { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }],
    [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }]
  ] });
  const requests: string[] = [];
  const stream = model.stream!; model.stream = input => { requests.push(JSON.stringify(input.messages)); return stream(input); };
  const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model, subagentProfiles: [], store: createInMemoryAgentRunStore() });
  try {
    const result = await runHarness(harness, { prompt: "Inspect module/file.ts" });
    expect(result.status).toBe("waiting_approval");
    expect(requests[0]).not.toContain("component-specific"); expect(requests[1]).toContain("component-specific");
    expect(result.state.metadata?.[SCOPED_CONTEXT_KEY]).toMatchObject({ entries: [{ path: "module/AGENTS.md" }] });
    await writeFile(path.join(root, "module/AGENTS.md"), "Changed instructions.");
    const resumed = await runHarness(harness, { state: result.state, approvals: result.state.pendingApprovals.map(approval => ({
      provider: approval.provider, approvalRequestId: approval.id, approve: true
    })) });
    expect(resumed.status).toBe("completed");
    expect(requests.at(-1)).toContain("Changed instructions.");
    const before = result.state.metadata?.[SCOPED_CONTEXT_KEY] as { entries: { digest: string }[] };
    const after = resumed.state.metadata?.[SCOPED_CONTEXT_KEY] as { entries: { digest: string }[] };
    expect(after.entries[0]!.digest).not.toBe(before.entries[0]!.digest);
    // Accepting revised guidance does not widen filesystem permissions.
    await rm(path.join(root, "module/AGENTS.md"));
    await symlink("file.ts", path.join(root, "module/AGENTS.md"));
    const calls = requests.length;
    const runtime = await createContextRuntime(harness.workspace, resumed.state.metadata ?? {}, true);
    await expect(wrapLanguageModel(model, [runtime.middleware]).stream!({ messages: [] })).rejects.toThrow();
    expect(requests).toHaveLength(calls);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

for (const commentary of [false, true]) test(`runtime stops repeated unchanged reads despite changing commentary: ${commentary}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "progress-runtime-"));
  await writeFile(path.join(root, "file.txt"), "unchanged");
  let calls = 0;
  const model = createMockLanguageModel();
  model.stream = async () => {
    calls++;
    return (async function* () {
      if (commentary) yield { type: "text-delta" as const, textDelta: `Investigation step ${calls}: I will inspect this file again to understand the implementation and determine which change will resolve the reported problem.` };
      yield { type: "tool-call" as const, toolCall: { id: `read-${calls}`, name: "read_file", input: { path: "file.txt" } } };
      yield { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    })();
  };
  const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model, subagentProfiles: [], store: createInMemoryAgentRunStore() });
  try {
    try { const result = await runHarness(harness, { prompt: "inspect", maxSteps: 10 }); expect(result.status).toBe("failed"); }
    catch (error) { expect(String(error)).toContain("NO_PROGRESS"); }
    expect(calls).toBe(5);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("six genuine user requests may reread the same file without inheriting a stalled turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "progress-user-turns-"));
  await writeFile(path.join(root, "file.txt"), "unchanged");
  let calls = 0;
  const model = createMockLanguageModel();
  model.stream = async () => {
    const index = calls++;
    return (async function* () {
      if (index % 2 === 0) yield { type: "tool-call" as const, toolCall: { id: `read-${index}`, name: "read_file", input: { path: "file.txt" } } };
      else yield { type: "text-delta" as const, textDelta: "Unchanged." };
      yield { type: "finish" as const, finishReason: index % 2 === 0 ? "tool-calls" as const : "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    })();
  };
  const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model,
    subagentProfiles: [], store: createInMemoryAgentRunStore() });
  try {
    let metadata = {};
    for (let turn = 0; turn < 6; turn++) {
      const result = await runHarness(harness, { prompt: "Please reread file.txt now.", metadata });
      expect(result.status).toBe("completed");
      metadata = result.state.metadata ?? {};
      expect((metadata as Record<string, { history: string[] }>)[PROGRESS_MONITOR_KEY]!.history).toHaveLength(1);
    }
    expect(calls).toBe(12);
    const stalled = createProgressMonitor();
    for (let index = 0; index < 5; index++) stalled.observeTool("read_file", { path: "file.txt" }, { content: "unchanged" });
    const continuation = await createContextRuntime(harness.workspace, { [PROGRESS_MONITOR_KEY]: stalled.snapshot() }, true);
    await expect(wrapLanguageModel(model, [continuation.middleware]).stream!({ messages: [] })).rejects.toThrow("NO_PROGRESS");
    expect(calls).toBe(12);
    await expect(runHarness(harness, { messages: [{ role: "assistant", parts: [{ type: "text", text: "Continue from the prior tool result." }] }],
      metadata: { [PROGRESS_MONITOR_KEY]: stalled.snapshot() } })).rejects.toThrow("NO_PROGRESS");
    await expect(runHarness(harness, { prompt: "[Compacted prior conversation]\n{}",
      metadata: { [PROGRESS_MONITOR_KEY]: stalled.snapshot() } })).rejects.toThrow("NO_PROGRESS");
    expect(calls).toBe(12);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
