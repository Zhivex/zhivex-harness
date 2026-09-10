import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tool, type JsonValue } from "@zhivex-ai/core";
import { z } from "zod";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { Workspace } from "../src/workspace.js";
import { createHarness, runHarness, renderHarnessInstructions, type HarnessRunDiagnostics } from "../src/harness.js";
import { TASK_SOURCE_KEY, taskSources } from "../src/task-memory.js";
import { REPAIR_PROGRESS_KEY, createRepairProgress } from "../src/repair-progress.js";
import { createEditProposal } from "../src/edit-contracts.js";
import { parseCliArgs } from "../src/cli.js";
import { resolveHarnessConfig } from "../src/config.js";
import type { HarnessOciRuntimeAdapter, HarnessExecutionSession } from "../src/execution-environment.js";

const fixture = async (body: (root: string) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-remediation-"));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const finish = { type: "finish" as const, finishReason: "tool-calls" as const, usage };
const call = (id: string, name: string, input: JsonValue) => ({ type: "tool-call" as const, toolCall: { id, name, input } });
const done = [{ type: "text-delta" as const, textDelta: "done" }, { ...finish, finishReason: "stop" as const }];

test("H02: rejects an ancestor swapped after workspace validation", () => fixture(async root => {
  await mkdir(path.join(root, "workspace", "parent"), { recursive: true }); await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "workspace", "parent", "file.txt"), "inside"); await writeFile(path.join(root, "outside", "file.txt"), "sentinel");
  const workspace = await Workspace.open(path.join(root, "workspace"));
  const internal = workspace as any, original = internal.safePath.bind(workspace); let swapped = false;
  internal.safePath = async (...args: unknown[]) => {
    const resolved = await original(...args);
    if (!swapped) { swapped = true; await rename(path.join(root, "workspace", "parent"), path.join(root, "workspace", "old")); await symlink(path.join(root, "outside"), path.join(root, "workspace", "parent")); }
    return resolved;
  };
  await expect(workspace.readFile("parent/file.txt")).rejects.toThrow();
}));

test("H04-H06: bounded search pages retain all matches and explicit incomplete coverage", () => fixture(async root => {
  await writeFile(path.join(root, "source.txt"), Array.from({ length: 140 }, () => "needle " + "x".repeat(490)).join("\n"));
  const workspace = await Workspace.open(root);
  const initial = await workspace.searchMany([{ query: "needle" }], "source.txt", { limitPerQuery: 500 });
  expect(JSON.stringify(initial).length).toBeLessThan(32_000);
  expect(initial.coverage.incomplete).toBe(true);
  const lines = initial.results[0]!.matches.map(m => m.line);
  let cursor = initial.results[0]!.nextCursor;
  while (cursor) {
    const page = await workspace.searchFiles("needle", "source.txt", { limit: 500, cursor });
    expect(JSON.stringify(page).length).toBeLessThan(32_000);
    lines.push(...page.matches.map(m => m.line)); cursor = page.nextCursor;
  }
  expect(lines).toEqual(Array.from({ length: 140 }, (_, i) => i + 1));
  await writeFile(path.join(root, "source.txt"), "changed");
  await expect(workspace.searchFiles("needle", "source.txt", { limit: 500, cursor: initial.results[0]!.nextCursor! })).rejects.toThrow("stale");
  await writeFile(path.join(root, "large.txt"), "only-large-marker" + "x".repeat(1024 * 1024));
  const skipped = await workspace.searchMany([{ query: "only-large-marker" }]);
  expect(skipped.results[0]!.matches).toHaveLength(0);
  expect(skipped.coverage).toMatchObject({ incomplete: true, skippedFiles: 1, skippedReasons: { tooLarge: 1 } });
}));

test("H03/H09: repair recovers full task on resume but refuses an unverified completion", () => fixture(async root => {
  await writeFile(path.join(root, "source.txt"), "small fixture");
  const task = "Fix parser. " + "background ".repeat(90) + "MANDATORY: retain escaped delimiters. API_KEY=sk-secret-value";
  const model = createMockLanguageModel({ streamEvents: [
    [call("read", "read_file", { path: "source.txt" }), finish],
    [call("write", "apply_reviewed_edits", { changes: [{ path: "created.txt", expectedDigest: null, content: "approved" }] }), finish],
    [call("recover", "read_task", {}), finish], done
  ] });
  const store = createInMemoryAgentRunStore();
  const h = await createHarness({ workspace: root, modelInstance: model, store, agentProfile: "repair", maxSteps: 8, compactionMaxMessages: 4, compactionKeepRecentMessages: 2 });
  let diagnostic: HarnessRunDiagnostics | undefined;
  const finishes: string[] = [];
  try {
    const waiting = await runHarness(h, { prompt: task });
    expect(waiting.status).toBe("waiting_approval");
    const saved = await store.load(waiting.state.runId);
    expect(taskSources(saved!.metadata)[0]!.text).toContain("MANDATORY: retain escaped delimiters.");
    expect(JSON.stringify(taskSources(saved!.metadata))).not.toContain("sk-secret-value");
    const result = await runHarness(h, { state: saved!, approvals: saved!.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) }, { onDiagnostics: d => { diagnostic = d; }, onEvent: event => { if (event.type === "agent-run-finish") finishes.push(event.status); } });
    expect(result.status).toBe("failed");
    expect(result.state.error?.message).toBe("REPAIR_INCOMPLETE");
    expect(finishes).toEqual(["failed"]);
    expect((result.state.compactions?.length ?? 0)).toBeGreaterThan(0);
    expect(result.toolResults.find(r => r.toolName === "read_task")?.output).toMatchObject({ content: expect.stringContaining("MANDATORY: retain escaped delimiters.") });
    expect(diagnostic?.budget?.inputTokens).toBe(40);
    expect(diagnostic?.modelTimings).toHaveLength(4);
    expect(result.state.metadata).toHaveProperty(REPAIR_PROGRESS_KEY);
    expect(await readFile(path.join(root, "created.txt"), "utf8")).toBe("approved");
  } finally { await h.close(); }
}));

test("H08: observations cannot reset repetition and resumed closure retains allowances", async () => {
  const metadata: Record<string, unknown> = {};
  const usage = { inputTokens: 0, outputTokens: 0 }, limits = { inputTokens: 100, outputTokens: 100 };
  const defs = Object.fromEntries(["read_file", "inspect_environment_patch", "run_environment_command", "verify_and_apply_environment_patch"].map(name => [name, tool({ name, schema: z.object({}), execute: async () => "same" })]));
  const controller = createRepairProgress(() => usage, limits);
  const tools = controller.wrapTools(defs);
  let step = 0;
  const invoke = (catalog: any, name: string, input = {}) => catalog[name].execute(input, { metadata, step: step++ });
  await invoke(tools, "read_file"); await invoke(tools, "inspect_environment_patch"); await invoke(tools, "read_file"); await invoke(tools, "inspect_environment_patch");
  await expect(invoke(tools, "read_file")).rejects.toThrow("REPEATED_EXPLORATION");
  usage.inputTokens = 70;
  for (let i = 0; i < 4; i++) await invoke(tools, "read_file", { startLine: i });
  const resumed = createRepairProgress(() => usage, limits, metadata).wrapTools(defs);
  await expect(invoke(resumed, "read_file")).rejects.toThrow("REPAIR_PHASE_BUDGET");
  for (let i = 0; i < 3; i++) await invoke(resumed, "run_environment_command");
  await expect(invoke(resumed, "run_environment_command")).rejects.toThrow("REPAIR_PHASE_BUDGET");
  expect(await invoke(resumed, "verify_and_apply_environment_patch")).toBe("same");
});

test("H06/H09: CLI exposes profile and instructions reflect the selected catalog", () => {
  expect(parseCliArgs(["run", "fix", "--agent-profile", "repair"]).agentProfile).toBe("repair");
  expect(resolveHarnessConfig({ agentProfile: "repair" }).agentProfile).toBe("repair");
  expect(() => resolveHarnessConfig({ agentProfile: "invented" })).toThrow();
  const rendered = renderHarnessInstructions(["read_files", "search_files", "read_task", "repair_plan"]);
  expect(rendered).not.toContain("mutation_audit"); expect(rendered).not.toContain("run_check");
  expect(rendered).toContain("never /workspace/src/file.py");
});

for (const scenario of ["before", "during", "lease-conflict", "lease-lost", "during-import", "timeout"] as const) {
  test(`H01/H07: terminal import blocks ${scenario} and OCI audit survives reacquisition`, () => fixture(async root => {
    await writeFile(path.join(root, "value.txt"), "before");
    const abort = new AbortController(); let executions = 0, loseLease = false;
    const store = createInMemoryAgentRunStore(); const renew = store.renewLease!.bind(store);
    store.renewLease = (...args) => loseLease ? Promise.resolve(undefined) : renew(...args);
    const runtime: HarnessOciRuntimeAdapter = {
      async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference, imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
      async run(request) {
        executions++; expect(request.abortSignal).toBeDefined();
        if (scenario === "during") abort.abort(new Error("operator cancelled"));
        if (scenario === "lease-lost") loseLease = true;
        return { command: request.command, exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
      }, async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
    };
    const input = { patchId: `sha256:${"0".repeat(64)}`, command: "node", args: ["check.mjs"] };
    const model = createMockLanguageModel({ streamEvents: [[call("verify", "verify_and_apply_environment_patch", input), finish]] });
    const h = await createHarness({ workspace: root, provider: "openai", modelInstance: model, store, executionBackend: "oci", ociRuntimeAdapter: runtime, ociAllowedCommands: ["node", "bun"] });
    try {
      const session = await h.executionEnvironment!.acquire({ runId: "fixture" }) as HarnessExecutionSession;
      const before = await session.workspace.readFile("value.txt");
      const changes = [{ path: "value.txt", expectedDigest: before.digest, content: "after" }];
      await session.workspace.applyPatch({ proposalId: createEditProposal({ changes }).proposalId, changes });
      input.patchId = (await session.inspectPatch()).patchId;
      await session.release?.({ status: "waiting_approval" });
      const reacquired = await h.executionEnvironment!.acquire({ runId: "fixture" }) as HarnessExecutionSession;
      expect(reacquired.workspace.mutationAudit()).toHaveLength(1);
      await reacquired.release?.({ status: "waiting_approval" });
      if (scenario === "during-import") {
        const original = h.workspace.applyPatchWithModes.bind(h.workspace);
        h.workspace.applyPatchWithModes = async (...args) => { abort.abort(new Error("cancelled after verifier before publication")); return original(...args); };
      }
      await expect(runHarness(h, { runId: "fixture", prompt: "verify", abortSignal: abort.signal, ...(scenario === "timeout" ? { timeoutMs: 100 } : {}) }, {
        terminalReceiptTools: ["verify_and_apply_environment_patch"], resolveApprovals: async pending => {
          if (scenario === "before") abort.abort(new Error("operator cancelled"));
          if (scenario === "timeout") return new Promise(() => {});
          if (scenario === "lease-conflict") expect(await store.acquireLease!("fixture", { ownerId: "other", ttlMs: 30_000 })).toBeTruthy();
          return pending.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
        }
      })).rejects.toThrow();
      expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before");
      expect(executions).toBe(scenario === "during" || scenario === "lease-lost" || scenario === "during-import" ? 1 : 0);
      if (scenario !== "lease-conflict") expect(await store.acquireLease!("fixture", { ownerId: "after", ttlMs: 30_000 })).toBeTruthy();
    } finally { await h.close(); }
  }));
}

test("H08: overlapping ranges and differently worded searches cannot hide repetition", async () => {
  const p = createRepairProgress(() => ({ inputTokens: 0, outputTokens: 0 }), { inputTokens: 100, outputTokens: 100 });
  const tools: any = p.wrapTools({
    read_file: tool({ name: "read_file", schema: z.object({ start: z.number() }), execute: async ({ start }) => ({ path: "a.ts", digest: "a".repeat(64), content: start === 1 ? "1: a\n2: b\n3: c" : "2: b\n3: c" }) }),
    search_files: tool({ name: "search_files", schema: z.object({ query: z.string() }), execute: async ({ query }) => ({ query, matches: [{ path: "a.ts", digest: "a".repeat(64), line: 2, text: "alpha beta gamma" }] }) })
  });
  await tools.read_file.execute({ start: 1 }, { step: 1 }); await tools.read_file.execute({ start: 1 }, { step: 2 });
  await expect(tools.read_file.execute({ start: 2 }, { step: 3 })).rejects.toThrow("REPEATED_EXPLORATION");
  await tools.search_files.execute({ query: "alpha" }, { step: 4 }); await tools.search_files.execute({ query: "beta" }, { step: 5 });
  await expect(tools.search_files.execute({ query: "gamma" }, { step: 6 })).rejects.toThrow("REPEATED_EXPLORATION");
});

test("H01: cancellation during publication rolls back already published writes", () => fixture(async root => {
  await writeFile(path.join(root, "source.txt"), "before"); const workspace = await Workspace.open(root);
  const current = await workspace.readFile("source.txt");
  const changes = [{ path: "source.txt", expectedDigest: current.digest, content: "after" }];
  let checkpoints = 0;
  await expect(workspace.applyPatchWithModes({ proposalId: createEditProposal({ changes }).proposalId, changes }, new Map(), async () => {
    if (++checkpoints === 2) throw new Error("cancelled after atomic publication");
  })).rejects.toThrow("cancelled");
  expect(await readFile(path.join(root, "source.txt"), "utf8")).toBe("before");
}));

test("H03/H09: memory tools are declared and usable inside the enforced OCI policy", () => fixture(async root => {
  const runtime: HarnessOciRuntimeAdapter = {
    async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference, imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
    async run() { throw new Error("Memory must not launch a process"); }, async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
  };
  const h = await createHarness({ workspace: root, provider: "openai", agentProfile: "repair", executionBackend: "oci", ociRuntimeAdapter: runtime, modelInstance: createMockLanguageModel({ streamEvents: [
    [call("task", "read_task", {}), finish],
    [call("plan", "repair_plan", { hypothesis: "Parser issue", expectedBehavior: "Preserve delimiters", paths: ["parser.py"], nextCheck: "Reproduce escaped input" }), finish], done
  ] }), maxSteps: 5 });
  try {
    const result = await runHarness(h, { prompt: "Preserve delimiters" });
    expect(result.status).toBe("completed");
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults.every(r => !r.isError)).toBe(true);
    expect(taskSources(result.state.metadata)[0]!.text).toBe("Preserve delimiters");
  } finally { await h.close(); }
}));

test("H04: ten-query response counts long-path cursor overhead and keeps continuation valid", () => fixture(async root => {
  const folder = ["a".repeat(180), "b".repeat(180), "c".repeat(180)].join("/");
  await mkdir(path.join(root, folder), { recursive: true });
  const queries = Array.from({ length: 10 }, (_, i) => ({ query: `needle-${i}-` + "x".repeat(180) }));
  await writeFile(path.join(root, folder, "source.txt"), Array.from({ length: 30 }, () => queries.map(q => q.query).join(" ")).join("\n"));
  const workspace = await Workspace.open(root);
  const initial = await workspace.searchMany(queries, ".", { limitPerQuery: 50 });
  expect(JSON.stringify(initial).length).toBeLessThanOrEqual(32_000);
  for (const group of initial.results) {
    const lines = group.matches.map(m => m.line);
    let cursor = group.nextCursor;
    if (group.truncated && !cursor && !lines.length) {
      const restart = await workspace.searchFiles(group.query, ".", { limit: 50 });
      lines.push(...restart.matches.map(m => m.line)); cursor = restart.nextCursor;
    }
    while (cursor) {
      const page = await workspace.searchFiles(group.query, ".", { limit: 50, cursor });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(32_000);
      lines.push(...page.matches.map(m => m.line)); cursor = page.nextCursor;
    }
    expect(lines).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  }
}));
