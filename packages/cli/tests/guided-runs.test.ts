import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace, openCliSessionStore, openWorkspaceCheckpointStore } from "@zhivex-ai/harness/engine";
import type { AgentApprovalRequest } from "@zhivex-ai/agents";
import { approvalFileDiff, formatFileDiff } from "../src/cli/terminal/file-diff.js";
import { handleConsoleCheckpoint } from "../src/cli/console/console-checkpoints.js";
import { catalogPrice, handleConsoleBudget } from "../src/cli/console/console-pricing.js";
import { consoleRunPolicyMetadata, restoreConsoleRunPolicy } from "../src/cli/console/console-run-policy.js";
import { parseCliArgs } from "../src/cli/arguments.js";

test("file diffs show changed regions, creations, empty files and exact newline differences safely", () => {
  const output = formatFileDiff({ path: "a\u001b[2J.txt", before: "same\nold\nlast\n", after: "same\nnew\nlast\n" });
  expect(output).toContain("-old\n+new\n"); expect(output).toContain(" same\n"); expect(output).not.toContain("\u001b");
  expect(formatFileDiff({ path: "a", before: "text", after: "text\n" })).toContain("\\ No newline at end of file");
  expect(formatFileDiff({ path: "a", before: null, after: "a\n" })).toContain("@@ -0,0 +1,1 @@\n+a\n");
  expect(formatFileDiff({ path: "a", before: "a\n", after: "" })).toContain("-a\n");
});

const fixture = async (run: (ctx: { workspace: Workspace; sessions: Awaited<ReturnType<typeof openCliSessionStore>> }) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-guided-"));
  const workspace = await Workspace.open(root);
  const sessions = await openCliSessionStore({ workspace: root, stateDirectory: path.join(root, ".zhivex-harness"), scope: { tenantId: "local" } });
  try { await writeFile(path.join(root, "a.txt"), "original\n"); await writeFile(path.join(root, "b.txt"), "original b\n"); await run({ workspace, sessions }); }
  finally { sessions.close(); await rm(root, { recursive: true, force: true }); }
};

test("approval preview uses engine preconditions and ignores provider tools with lookalike names", () => fixture(async ({ workspace }) => {
  const current = await workspace.readFile("a.txt");
  const request = { kind: "local-tool", name: "apply_reviewed_edits", arguments: JSON.stringify({ changes: [
    { path: "a.txt", expectedDigest: current.digest, content: "changed\n" }] }) } as AgentApprovalRequest;
  expect(await approvalFileDiff(workspace, request)).toContain("-original\n+changed\n");
  expect(await approvalFileDiff(workspace, { ...request, kind: "provider" })).toBeUndefined();
  await writeFile(path.join(workspace.root, "a.txt"), "user edit\n");
  expect(await approvalFileDiff(workspace, request)).toContain("could not be validated");
  expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe("user edit\n");
}));

test("checkpoint UI requires two reviews, preserves original sessions and rejects partial restore retries", () => fixture(async ({ workspace, sessions }) => {
  const session = await sessions.create({ initialRun: { runId: "run-fixture", provider: "test", model: "test", status: "completed" } });
  let output = "", selected = "", switched = "";
  const questions: string[] = [];
  const context = { workspace, sessions, session, hasActiveTurn: async () => false,
    input: { select: async <T>() => selected as T, question: async (text: string) => { questions.push(text); return text.startsWith("Review current") ? "prepare" : "restore"; } },
    restoreSession: async (fork: typeof session) => { switched = fork.sessionId; }, write: (text: string) => { output += text; } };
  await handleConsoleCheckpoint('/checkpoint capture ["a.txt","b.txt"]', context);
  const store = await openWorkspaceCheckpointStore(workspace, sessions);
  try { selected = store.listCheckpoints(session.sessionId)[0]!.id; } finally { store.close(); }
  await writeFile(path.join(workspace.root, "a.txt"), "agent a\n");
  await writeFile(path.join(workspace.root, "b.txt"), "agent b\n");
  const originalApply = workspace.applyPatchWithModes.bind(workspace);
  workspace.applyPatchWithModes = async () => { await writeFile(path.join(workspace.root, "a.txt"), "original\n"); throw new Error("Injected partial operation"); };
  await expect(handleConsoleCheckpoint("/checkpoint restore", context)).rejects.toThrow("Injected partial");
  workspace.applyPatchWithModes = originalApply;
  expect(questions).toHaveLength(2); expect(switched).toBe("");
  const reopened = await openWorkspaceCheckpointStore(workspace, sessions);
  try { selected = reopened.listRestores(session.sessionId)[0]!.id; } finally { reopened.close(); }
  await expect(handleConsoleCheckpoint("/checkpoint retry", context)).rejects.toThrow();
  expect(await readFile(path.join(workspace.root, "b.txt"), "utf8")).toBe("agent b\n");
  expect(await sessions.get(session.sessionId)).toBeDefined();
  expect(output).toContain("No automatic rollback");
}));

test("checkpoint UI blocks active turns and unavailable files without narrowing the restore set", () => fixture(async ({ workspace, sessions }) => {
  const session = await sessions.create({ initialRun: { runId: "run-fixture", provider: "test", model: "test", status: "completed" } });
  let output = "";
  const store = await openWorkspaceCheckpointStore(workspace, sessions);
  const checkpoint = await store.capture({ sessionId: session.sessionId, turnId: session.runs[0]!.turnId, paths: ["a.txt", "b.txt"] }); store.close();
  const context = { workspace, sessions, session, hasActiveTurn: async () => true,
    input: { select: async <T>() => checkpoint.id as T, question: async () => { throw new Error("Must not ask to restore"); } },
    restoreSession: async () => {}, write: (text: string) => { output += text; } };
  await handleConsoleCheckpoint("/checkpoint restore", context); expect(output).toContain("Finish or deny");
  await rm(path.join(workspace.root, "b.txt"));
  await handleConsoleCheckpoint("/checkpoint restore", { ...context, hasActiveTurn: async () => false });
  expect(output).toContain("unavailable; restore blocked");
}));

test("budget UI fails closed on missing/stale pricing, requires review and restores next-run defaults", () => fixture(async ({ workspace }) => {
  let output = "", next = parseCliArgs(["chat"]), confirmed = false;
  const file = path.join(workspace.root, "prices.json");
  const price = { schemaVersion: 1, prices: [{ provider: "openai", model: "fixture", inputUsdPerMillion: 1,
    outputUsdPerMillion: 2, source: "synthetic", asOf: "2020-01-01T00:00:00Z", expiresAt: "2021-01-01T00:00:00Z" }] };
  await writeFile(file, JSON.stringify(price));
  const context = { options: next, provider: "openai", model: "fixture", hasActiveTurn: async () => false,
    input: { select: async <T>() => "" as T, question: async (text: string) => text.startsWith("Pricing") ? file : confirmed ? "budget" : "" },
    replaceOptions: async (value: typeof next) => { next = value; }, write: (text: string) => { output += text; } };
  await handleConsoleBudget("/budget 1", context); expect(next.usageLimitUsd).toBeUndefined(); expect(output).toContain("missing or stale");
  price.prices[0]!.asOf = new Date(Date.now() - 1000).toISOString(); price.prices[0]!.expiresAt = new Date(Date.now() + 60_000).toISOString();
  await writeFile(file, JSON.stringify(price));
  await handleConsoleBudget("/budget 1", context); expect(next.usageLimitUsd).toBeUndefined();
  confirmed = true;
  await handleConsoleBudget("/budget 1", context); expect(next.usageLimitUsd).toBe(1); expect(next.pricingFile).toBe(file);
  expect(restoreConsoleRunPolicy(parseCliArgs(["chat"]), { metadata: consoleRunPolicyMetadata(next) })).toMatchObject({ usageLimitUsd: 1, pricingFile: file });
  expect(output).toContain("per RUN"); expect(catalogPrice(undefined)).toBe("Price: unknown");
}));
