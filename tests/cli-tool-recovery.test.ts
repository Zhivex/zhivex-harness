import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { cliToolExecution } from "../src/cli/tool-execution.js";

for (const scenario of ["recover", "stop", "budget"] as const) {
  test(`CLI unknown tool recovery: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cli-tool-recovery-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      await writeFile(path.join(root, "sample.txt"), "needle");
      harness = await createHarness({ workspace: root,
        maxToolErrors: scenario === "budget" ? 0 : 4,
        modelInstance: createMockLanguageModel({ streamEvents: [
          [{ type: "tool-call", toolCall: { id: "unknown", name: "grep_search", input: { query: "needle" } } },
            { type: "finish", finishReason: "tool-calls" }],
          [{ type: "tool-call", toolCall: { id: "corrected", name: "search_files", input: { path: ".", query: "needle" } } },
            { type: "finish", finishReason: "tool-calls" }],
          [{ type: "text-delta", textDelta: "Found needle." }, { type: "finish", finishReason: "stop" }]
        ] }) });
      const run = runHarness(harness, { prompt: "Find needle", toolExecution: {
        ...cliToolExecution, stopOnError: scenario === "stop"
      } });
      if (scenario === "stop") {
        await expect(run).rejects.toThrow("Tool is not registered");
      } else if (scenario === "budget") {
        await expect(run).rejects.toThrow("maxToolErrors");
      } else {
        const result = await run;
        expect(result.status).toBe("completed");
        expect(result.toolResults).toHaveLength(2);
        expect(result.toolResults[0]?.isError).toBe(true);
        expect(JSON.stringify(result.toolResults[0]?.error)).toContain("TOOL_NOT_REGISTERED");
        expect(result.toolResults[1]?.toolName).toBe("search_files");
        expect(result.toolResults[1]?.isError).not.toBe(true);
        expect(result.outputText).toContain("Found needle.");
      }
    } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("CLI overlaps trusted reads through the durable harness and journals every result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-parallel-reads-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const watchdog = setTimeout(release, 1000);
  try {
    await Promise.all(["a.txt", "b.txt"].map(name => writeFile(path.join(root, name), name)));
    harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel({
      streamEvents: [[
        ...["a.txt", "b.txt"].map((name, index) => ({ type: "tool-call" as const,
          toolCall: { id: `read-${index}`, name: "read_file", input: { path: name } } })),
        { type: "finish", finishReason: "tool-calls" }
      ], [{ type: "text-delta", textDelta: "Read both files." }, { type: "finish", finishReason: "stop" }]]
    }) });
    const read = harness.workspace.readFile.bind(harness.workspace);
    let active = 0, peak = 0;
    harness.workspace.readFile = async (...args: Parameters<typeof read>) => {
      active++; peak = Math.max(peak, active);
      if (active === 2) release();
      try { await barrier; return await read(...args); } finally { active--; }
    };
    const result = await runHarness(harness, { prompt: "Read both files", toolExecution: { ...cliToolExecution } });
    expect(peak).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.toolResults.map(value => value.isError ?? false)).toEqual([false, false]);
    const journal = await harness.store.listToolCalls!(result.state.runId, result.state.scope);
    expect(journal).toHaveLength(2);
    expect(journal.every(entry => entry.status === "completed")).toBe(true);
    expect(new Set(journal.map(entry => entry.toolCallId)).size).toBe(2);
  } finally { clearTimeout(watchdog); release(); await harness?.close(); await rm(root, { recursive: true, force: true }); }
});
