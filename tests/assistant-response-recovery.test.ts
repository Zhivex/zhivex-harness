import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { appendUserMessage, compactHarnessMessages, createHarness, runHarness } from "../src/runtime/harness.js";
import { ASSISTANT_RESPONSE_KEY, assistantResponses, TASK_SOURCE_KEY, taskSources } from "../src/context/task-memory.js";

const marker = "LATE_PLAN_REFERENCE_92ab";
const report = "Audit evidence. ".repeat(1500) + `\n## Short-term plan\n1. Preserve exact approvals. ${marker}`;
const recallEvents = [
  [{ type: "tool-call" as const, toolCall: { id: "recall", name: "read_task", input: { source: "assistant_response", query: "## Short-term plan" } } }, { type: "finish" as const, finishReason: "tool-calls" as const }],
  [{ type: "text-delta" as const, textDelta: "Recovered the referenced plan." }, { type: "finish" as const, finishReason: "stop" as const }],
];

test("the first terminal checkpoint retains a generated report before immediate manual compaction", async () => {
  const root = await mkdtemp("/tmp/har-first-response-");
  const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: createMockLanguageModel({ streamEvents: [
    [{ type: "text-delta", textDelta: report }, { type: "finish", finishReason: "stop" }], ...recallEvents,
  ] }), subagentProfiles: [] });
  try {
    let capturedBeforeFinish = false;
    const first = await runHarness(harness, { prompt: "Audit only; do not modify files." }, { onEvent: async event => {
      if (event.type === "agent-run-finish") {
        const checkpoint = await harness.store.load(event.state.runId, harness.config.scope);
        capturedBeforeFinish = assistantResponses(checkpoint?.metadata).some(source => source.text.includes(marker));
      }
    } });
    expect(first.status).toBe("completed");
    expect(capturedBeforeFinish).toBe(true);
    expect(assistantResponses(first.state.metadata).map(source => source.text)).toEqual([report]);
    expect(taskSources(first.state.metadata).map(source => source.text)).toEqual(["Audit only; do not modify files."]);
    let compacted = compactHarnessMessages(first.messages);
    for (let i = 0; i < 3; i++) compacted = compactHarnessMessages(appendUserMessage(compacted, `Continue ${i}`));
    expect(JSON.stringify(compacted)).not.toContain(marker);
    // No intervening capture run and no metadata argument: direct callers retain
    // bounded context with the host-created summary object after array copies.
    const next = await runHarness(harness, { messages: appendUserMessage(compacted, "Refer to point 1; read only.") });
    const recovered = next.toolResults.find(result => result.toolName === "read_task");
    expect(recovered?.output).toMatchObject({ source: "assistant_response", untrusted: true, verified: false });
    expect(JSON.stringify(recovered?.output)).toContain(marker);
    expect(next.state.pendingApprovals).toEqual([]);
    expect(harness.workspace.mutationAudit()).toEqual([]);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("serialized compacted continuation after host restart uses only its retained assistant context", async () => {
  const root = await mkdtemp("/tmp/har-response-restart-");
  let harness = await createHarness({ workspace: root, provider: "openai", subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: [
    [{ type: "text-delta", textDelta: report }, { type: "finish", finishReason: "stop" }],
  ] }) });
  try {
    const first = await runHarness(harness, { prompt: "Audit only." });
    const serialized = JSON.parse(JSON.stringify(compactHarnessMessages(first.messages)));
    expect(JSON.stringify(serialized)).not.toContain(marker);
    await harness.close();
    harness = await createHarness({ workspace: root, provider: "openai", subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: recallEvents }) });
    const saved = (await harness.store.load(first.state.runId, harness.config.scope))!;
    const next = await runHarness(harness, { messages: appendUserMessage(serialized, "Recover point 1 without editing."), metadata: {
      [TASK_SOURCE_KEY]: taskSources(saved.metadata), [ASSISTANT_RESPONSE_KEY]: saved.metadata?.[ASSISTANT_RESPONSE_KEY] ?? [],
    } });
    expect(JSON.stringify(next.toolResults.find(result => result.toolName === "read_task")?.output)).toContain(marker);
    expect(taskSources(next.state.metadata).map(source => source.text)).toEqual(["Audit only.", "Recover point 1 without editing."]);
    expect(harness.workspace.mutationAudit()).toEqual([]);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
