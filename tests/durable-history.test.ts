import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { openHarnessPersistence, HARNESS_SQLITE_FILE } from "../src/persistence/operations.js";
import { createHarnessStateBackup, importHarnessStateBackup } from "../src/persistence/state-backup.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { terminalRunFailure } from "../src/cli/terminal/terminal-ui.js";

test("long harness run survives compaction, reopen and a portable backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-history-"));
  const count = 200;
  const contents = Array.from({ length: 300 }, (_, i) => `${i} ${"x".repeat(77)}`).join("\n");
  await Promise.all(Array.from({ length: count }, (_, i) => writeFile(path.join(root, `fixture-${i}.txt`), contents)));
  const model = createMockLanguageModel({ streamEvents: Array.from({ length: count + 1 }, (_, i) => [
    ...(i < count ? [{ type: "tool-call" as const, toolCall: { id: `read-${i}`, name: "read_file", input: { path: `fixture-${i}.txt`, startLine: 1, endLine: 300 } } }]
      : [{ type: "text-delta" as const, textDelta: "Inspection complete." }]),
    { type: "finish" as const, finishReason: i < count ? "tool-calls" as const : "stop" as const }
  ]) });
  const harness = await createHarness({ workspace: root, provider: "qwen", model: "qwen3.8-flash", modelInstance: model,
    toolNames: ["read_file"], subagentProfiles: [], unlimitedTokens: true, maxSteps: count + 1, maxToolCalls: count,
    compactionMaxMessages: 6, compactionKeepRecentMessages: 2 });
  try {
    const result = await runHarness(harness, { prompt: "Inspect the fixture. Do not edit files.", scope: harness.config.scope });
    expect(result.status).toBe("completed");
    expect(result.toolResults).toHaveLength(count);
    expect(result.toolResults.every(item => !item.isError)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.state))).toBeGreaterThan(4 * 1024 * 1024);
    expect(result.state.compactions!.length).toBeGreaterThan(30);
    expect(harness.store.checkpointBytes!(result.state)).toBeLessThan(250_000);
    const db = new SqliteDatabase(path.join(harness.config.stateDirectory, HARNESS_SQLITE_FILE));
    const stored = db.query<{ state_json: string }>("SELECT state_json FROM zhivex_agent_runs WHERE json_extract(state_json, '$.runId') = ?").get(result.state.runId)!;
    expect(Buffer.byteLength(stored.state_json)).toBeLessThan(250_000);
    console.info("Durable history regression:", { reads: count, compactions: result.state.compactions!.length,
      hydratedBytes: Buffer.byteLength(JSON.stringify(result.state)), checkpointBytes: Buffer.byteLength(stored.state_json) });
    expect(JSON.parse(stored.state_json).steps).toEqual([]);
    db.close();
    await harness.close();
    const reopened = await openHarnessPersistence(harness.config);
    expect(await reopened.store.load(result.state.runId, result.state.scope)).toEqual(result.state);
    expect(await reopened.store.loadHistory!(result.state.runId, { field: "toolResults", offset: 100, limit: 2 }, result.state.scope))
      .toEqual(result.toolResults.slice(100, 102));
    reopened.close();
    const backup = await createHarnessStateBackup(harness.config);
    expect(backup.records.runs[0]!.state.toolResults).toEqual(result.toolResults);
    expect(backup.records.runs[0]!.state).not.toHaveProperty("checkpointHistory");
    const target = resolveHarnessConfig({ workspace: root, stateDirectory: path.join(root, "restored"), provider: "qwen", model: "qwen3.8-flash" });
    await importHarnessStateBackup(target, backup);
    const restored = await openHarnessPersistence(target);
    expect((await restored.store.load(result.state.runId, result.state.scope))!.toolResults).toEqual(result.toolResults);
    restored.close();
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test("state-limit diagnostic is specific and does not leak arbitrary error text", () => {
  expect(terminalRunFailure(new Error("Agent run state is 4199433 bytes and exceeds maxStateBytes=4194304. Offload large tool outputs to artifacts or raise the explicit limit.")))
    .toBe("durable state limit reached · 4199433 / 4194304 bytes · inspect /status before /continue");
  expect(terminalRunFailure(new Error("Agent run state is SECRET"))).not.toContain("SECRET");
});
