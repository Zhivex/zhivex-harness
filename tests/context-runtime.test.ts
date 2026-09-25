import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { SCOPED_CONTEXT_KEY } from "../src/runtime/context-runtime.js";

test("runtime discovers scoped guidance after a successful read, persists identities and refuses drift on resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scoped-runtime-"));
  await mkdir(path.join(root, "module"));
  await writeFile(path.join(root, "module/AGENTS.md"), "Use component-specific conventions.");
  await writeFile(path.join(root, "module/file.ts"), "export const x = 1;");
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "read", name: "read_file", input: { path: "module/file.ts" } } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }],
    [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }]
  ] });
  const requests: string[] = [];
  const stream = model.stream!; model.stream = input => { requests.push(JSON.stringify(input.messages)); return stream(input); };
  const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model, subagentProfiles: [], store: createInMemoryAgentRunStore() });
  try {
    const result = await runHarness(harness, { prompt: "Inspect module/file.ts" });
    expect(result.status).toBe("completed");
    expect(requests[0]).not.toContain("component-specific"); expect(requests[1]).toContain("component-specific");
    expect(result.state.metadata?.[SCOPED_CONTEXT_KEY]).toMatchObject({ entries: [{ path: "module/AGENTS.md" }] });
    await writeFile(path.join(root, "module/AGENTS.md"), "Changed instructions.");
    await expect(runHarness(harness, { state: result.state })).rejects.toThrow("changed after discovery");
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime stops repeated unchanged reads before another paid model request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "progress-runtime-"));
  await writeFile(path.join(root, "file.txt"), "unchanged");
  let calls = 0;
  const model = createMockLanguageModel();
  model.stream = async () => {
    calls++;
    return (async function* () {
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
