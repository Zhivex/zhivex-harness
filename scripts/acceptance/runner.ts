import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguageModel, AgentRunOutput, AgentApprovalRequest } from "@zhivex-ai/agents";
import { runPortableProcess } from "../../src/execution/process-runtime.js";
import { sanitizeOperationalError } from "../release-diagnostics.js";
import { ACCEPTANCE_LIMITS, type AcceptanceFixture } from "./fixtures.js";

type Engine = typeof import("../../src/engine/index.js");
export interface AcceptanceRoute { provider: string; model: string; route: string }
export interface AcceptanceAttempt {
  scenario: string; attempt: number; provider: string; model: string; route: string;
  status: "passed" | "failed" | "blocked"; durationMs: number;
  automatedApprovals: number; humanInterventions: number; scriptedUserCorrections: number; restarted: boolean; compactions: number;
  effectiveBudget?: unknown; usage: unknown[]; costUsd: null; costEvidence: "unavailable";
  independentTestsPassed: boolean; protectedFilesUnchanged: boolean; initialTestsFailed: boolean;
  diagnostic?: unknown;
}
/** Strict aggregate: retries are retained, and cannot turn first-attempt certification green. */
export function summarizeAcceptance(rows: readonly AcceptanceAttempt[], expectedCases: number) {
  const first = rows.filter(row => row.attempt === 1);
  const unique = new Set(first.map(row => `${row.provider}/${row.model}/${row.route}/${row.scenario}`));
  return { status: first.length === expectedCases && unique.size === expectedCases && first.every(row => row.status === "passed") ? "passed" : "failed",
    expectedCases, attemptedCases: unique.size, firstAttemptPassed: first.filter(row => row.status === "passed").length,
    recovered: rows.filter(row => row.attempt > 1 && row.status === "passed").length,
    failedAttempts: rows.filter(row => row.status === "failed").length, blockedAttempts: rows.filter(row => row.status === "blocked").length };
}
export async function runAcceptanceCase(api: Engine, fixture: AcceptanceFixture, route: AcceptanceRoute,
  attempt = 1, modelInstance?: LanguageModel): Promise<AcceptanceAttempt> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-acceptance-"));
  const workspace = path.join(root, "workspace");
  const verifier = path.join(root, "verifier");
  const started = Date.now();
  const row: AcceptanceAttempt = { ...route, scenario: fixture.id, attempt, status: "failed", durationMs: 0,
    automatedApprovals: 0, humanInterventions: 0, scriptedUserCorrections: 0, restarted: false, compactions: 0,
    usage: [], costUsd: null, costEvidence: "unavailable", independentTestsPassed: false, protectedFilesUnchanged: false, initialTestsFailed: false };
  let harness: Awaited<ReturnType<Engine["createHarness"]>> | undefined;
  const originals = { ...fixture.files,
    "verify.mjs": fixture.mode === "correction" ? fixture.oracle.split("assert.equal(cents(-1.005)")[0]! : fixture.oracle,
    "package.json": JSON.stringify({ private: true, type: "module", packageManager: "bun@1.4.0", scripts: { test: "bun verify.mjs" } }) };
  const read = (name: string) => readFile(path.join(workspace, name), "utf8");
  const unchanged = async () => {
    for (const [name, content] of Object.entries(originals)) if (!fixture.editable.includes(name) && await read(name).catch(() => null) !== content) return false;
    return true;
  };
  const check = () => runPortableProcess(["bun", "verify.mjs"], { cwd: workspace, timeoutMs: 10_000 });
  const record = (result: AgentRunOutput) => { row.usage.push({ runId: result.state.runId, cumulative: result.usage ?? null }); row.compactions = Math.max(row.compactions, result.state.compactions?.length ?? 0); };
  const options = { provider: route.provider, model: route.model, workspace, ...ACCEPTANCE_LIMITS,
    allowedChecks: ["test"], requireVerifiedDelivery: false, projectContext: false,
    ...(fixture.mode === "restart" ? { compactionMaxMessages: 4, compactionKeepRecentMessages: 2, compactionMaxEstimatedInputTokens: 10_000 } : {}),
    ...(modelInstance ? { modelInstance } : {}) };
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    for (const [name, content] of Object.entries(originals)) await writeFile(path.join(workspace, name), content);
    row.initialTestsFailed = (await check()).exitCode !== 0;
    assert(row.initialTestsFailed, "Fixture must fail before repair");
    if (!modelInstance && !api.providerAvailability().find(p => p.id === route.provider)?.configured) {
      row.status = "blocked"; row.diagnostic = { code: "MISSING_CREDENTIALS" }; return row;
    }
    harness = await api.createHarness(options);
    row.effectiveBudget = harness.config.budget;
    const approve = (batch: readonly AgentApprovalRequest[]) => batch.map(a => {
      const args = JSON.parse(a.arguments);
      const edit = ["apply_reviewed_edits", "apply_patch"].includes(a.name) && Array.isArray(args.changes) && args.changes.length > 0 && args.changes.every((c: { path: string; content: string }) => fixture.editable.includes(c.path) && typeof c.content === "string" && c.content.length < 16384);
      const replace = a.name === "apply_reviewed_replacement" && fixture.editable.includes(args.path) && typeof args.newText === "string" && args.newText.length < 16384;
      const runCheck = a.name === "run_check" && args.check === "test" && args.expectedScript === "bun verify.mjs";
      assert(edit || replace || runCheck, "Operation outside acceptance policy");
      row.automatedApprovals++;
      return { provider: a.provider, approvalRequestId: a.id, approve: true, reason: "Automated fixture policy; not a human approval." };
    });
    let result = await api.runHarness(harness, (fixture.mode === "restart" ? { messages: [
        ...Array.from({ length: 8 }, (_, index) => ({ role: (index % 2 ? "assistant" : "user") as "assistant" | "user", parts: [{ type: "text" as const, text: `Context ${index}: preserve the protected tests.` }] })),
        { role: "user" as const, parts: [{ type: "text" as const, text: fixture.task }] }
      ] } : { prompt: fixture.task }));
    record(result);
    // Every fixture must actually exercise a governed operation, not only prose.
    assert.equal(result.status, "waiting_approval", "Expected a durable approval boundary");
    for (const name of fixture.editable) assert.equal(await read(name), fixture.files[name], "No writes before approval");
    if (fixture.mode === "cancellation") {
      await api.cancelHarnessRun(harness.store, harness.config, result.state.runId, { reason: "Acceptance cancellation", final: true });
      const state = await harness.store.load(result.state.runId, harness.config.scope);
      assert(state);
      const cancelled = await api.runHarness(harness, { state });
      assert.equal(cancelled.status, "cancelled");
      for (const name of fixture.editable) assert.equal(await read(name), fixture.files[name], "Cancelled work mutated files");
      row.independentTestsPassed = true; // Cancellation oracle is unchanged bytes + non-completion.
    } else {
      if (fixture.mode === "restart") {
        const runId = result.state.runId;
        await harness.close(); harness = await api.createHarness(options);
        const state = await harness.store.load(runId, harness.config.scope);
        assert(state); result = { ...result, state }; row.restarted = true;
      }
      result = await api.runHarness(harness, { state: result.state, approvals: approve(result.state.pendingApprovals) }, { resolveApprovals: async batch => approve(batch) });
      record(result);
      assert.equal(result.status, "completed", "Incomplete work is not accepted");
      if (fixture.mode === "failed-check") assert(result.toolResults.some(tool => tool.toolName === "run_check" && tool.output && typeof tool.output === "object" && "exitCode" in tool.output && tool.output.exitCode !== 0), "Expected failed check receipt before recovery");
      if (fixture.mode === "correction") {
        row.scriptedUserCorrections = 1; // Distinct from an actual human intervention.
        result = await api.runHarness(harness, { messages: api.appendUserMessage(result.state.messages, fixture.correction!) }, { resolveApprovals: async batch => approve(batch) });
        record(result); assert.equal(result.status, "completed");
      }
      if (fixture.mode === "restart") assert(row.compactions > 0 && row.restarted, "Expected compaction and durable restart");
      // Run a protected copy of the oracle over only allowlisted regular implementation files.
      await mkdir(path.join(verifier, "src"), { recursive: true });
      await writeFile(path.join(verifier, "package.json"), '{"type":"module"}');
      for (const name of fixture.editable) {
        const stat = await lstat(path.join(workspace, name)); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 16384);
        await writeFile(path.join(verifier, name), await read(name));
      }
      await writeFile(path.join(verifier, "verify.mjs"), fixture.oracle);
      row.independentTestsPassed = (await runPortableProcess(["bun", "verify.mjs"], { cwd: verifier, timeoutMs: 10_000 })).exitCode === 0;
      assert(row.independentTestsPassed, "Independent protected tests failed");
      for (const name of fixture.editable) assert.notEqual(await read(name), fixture.files[name], "Expected every implementation file to change");
    }
    row.protectedFilesUnchanged = await unchanged();
    assert(row.protectedFilesUnchanged, "Protected fixture changed");
    assert.deepEqual((await readdir(path.join(workspace, "src"))).sort(), fixture.editable.map(name => path.basename(name)).sort(), "Unexpected implementation files");
    row.status = "passed";
  } catch (error) { row.diagnostic = sanitizeOperationalError(error); }
  finally { row.durationMs = Date.now() - started; row.protectedFilesUnchanged = await unchanged(); await harness?.close(); await rm(root, { recursive: true, force: true }); }
  return row;
}
export const fixtureDigest = (fixtures: readonly AcceptanceFixture[]) => createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");
