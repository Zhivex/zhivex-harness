import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import type { AgentRunState, AgentRunStore } from "@zhivex-ai/core";
import { APPROVAL_HISTORY_KEY } from "../src/approvals/approval-history.js";
import { canonicalizeAuditPackManifest, exportHarnessAuditPack, loadAuditSigningKey, verifyHarnessAuditPack } from "../src/audit/index.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { exportHarnessGovernanceReport } from "../src/persistence/governance-report.js";
import { TASK_BUDGET_ACCOUNT_KEY, TaskBudget } from "../src/runtime/task-budget.js";
import { USAGE_LEDGER_KEY } from "../src/runtime/usage-ledger.js";

const key = Buffer.alloc(32, 7);
const secret = "TOP_SECRET_CUSTOM_MARKER@example.com";
const state = (overrides: Partial<AgentRunState> = {}) => ({ runId: "run-1", revision: 1, status: "completed", messages: [], pendingApprovals: [], childRuns: [], metadata: {}, outputText: secret, ...overrides } as AgentRunState);
const memory = (states: AgentRunState[]): AgentRunStore => ({
  load: async id => structuredClone(states.find(item => item.runId === id)),
  save: async () => { throw new Error("EXPORT_MUST_NOT_WRITE"); }
});

test("a run pack reuses the governance report, approval view, usage projection and redacted journal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit-pack-"));
  const run = state({ metadata: {
    [APPROVAL_HISTORY_KEY]: [{ approvalId: secret, name: "run_check", digest: "b".repeat(64), approved: false, decidedAt: 1, reviewedRevision: 1 }],
    [USAGE_LEDGER_KEY]: { schemaVersion: 1, runId: "run-1", calls: 2, inputTokens: 4, outputTokens: 1, usageComplete: false, historicalUsageUnknown: true, estimatedUsd: null, limitUsd: null, costKind: "estimate-not-invoice", routes: [] }
  } });
  const policy = { schemaVersion: 1, type: "policy-decision", phase: "tool-entry", toolName: "run_check", decision: "deny", ruleIds: [], reason: "kept", reasonTruncated: false, policyDigest: null, source: "baseline", approvalRequired: false, explicitReviewRequired: false, executionBackend: "none", evidence: "policy-evaluation" };
  const session = {
    id: "ses",
    index: { get: async () => ({ sessionId: "ses", revision: 1, runs: [{ runId: "run-1" }] }) },
    history: { replay: (_id: string, after = 0) => after > 0
      ? { schemaVersion: 1 as const, cursorExpired: false, hasMore: false, nextCursor: 2, events: [] }
      : { schemaVersion: 1 as const, cursorExpired: false, hasMore: false, nextCursor: 2, events: [{ sessionId: "ses", runId: "run-1", sequence: 1, at: 5, activity: { type: "text-delta", textDelta: "[REDACTED]" } }, { sessionId: "ses", runId: "run-1", sequence: 2, at: 6, activity: policy }] } }
  };
  try {
    const directory = path.join(root, "pack");
    const manifest = await exportHarnessAuditPack({ store: memory([run]), subjectId: "run-1", directory, signingKey: key, now: 1_700_000_000_000, session: session as never });
    expect(manifest.subject).toEqual({ kind: "run", id: "run-1", runIds: ["run-1"] });
    expect(manifest.files.map(file => file.path)).toEqual(["approvals.json", "governance-report.json", "policy-decisions.json", "redaction.jsonl", "usage-ledger.json"]);
    const report = JSON.parse(await readFile(path.join(directory, "governance-report.json"), "utf8"));
    expect(report).toEqual(await exportHarnessGovernanceReport(memory([run]), undefined, "run-1", { session: session as never, now: 1_700_000_000_000 }));
    const approvals = JSON.parse(await readFile(path.join(directory, "approvals.json"), "utf8"));
    expect(approvals.decisions[0].status).toBe("rejected");
    const usage = JSON.parse(await readFile(path.join(directory, "usage-ledger.json"), "utf8"));
    expect(usage.projection).toMatchObject({ calls: 2, inputTokens: 4, usageComplete: false });
    expect(usage.transportAvailability).toBe("unavailable");
    const policyFile = JSON.parse(await readFile(path.join(directory, "policy-decisions.json"), "utf8"));
    expect(policyFile.decisions).toEqual([{ sequence: 2, event: policy }]);
    const lines = (await readFile(path.join(directory, "redaction.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ kind: "zhivex-redaction-log", availability: "recorded", count: 2 });
    expect(lines[1].activity.textDelta).toBe("[REDACTED]");
    const packed = await readFile(path.join(directory, "manifest.json"), "utf8") + await readFile(path.join(directory, "governance-report.json"), "utf8") + await readFile(path.join(directory, "approvals.json"), "utf8");
    expect(packed).not.toContain(secret);
    expect(await verifyHarnessAuditPack({ directory, signingKey: key })).toMatchObject({ subject: manifest.subject, fileCount: 5, keyId: manifest.signature.keyId });
    const reordered = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ signature: reordered.signature, files: reordered.files, subject: reordered.subject, createdAt: reordered.createdAt, exporterVersion: reordered.exporterVersion, integrity: reordered.integrity, kind: reordered.kind, schemaVersion: reordered.schemaVersion }));
    expect((await verifyHarnessAuditPack({ directory, signingKey: key })).fileCount).toBe(5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification rejects tampering, a foreign key, extra files and a short key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit-pack-"));
  const directory = path.join(root, "pack");
  try {
    await exportHarnessAuditPack({ store: memory([state()]), subjectId: "run-1", directory, signingKey: key, now: 1_700_000_000_000 });
    const approvals = path.join(directory, "approvals.json");
    const original = await readFile(approvals);
    await writeFile(approvals, original.subarray(0, original.length - 2));
    await expect(verifyHarnessAuditPack({ directory, signingKey: key })).rejects.toThrow("AUDIT_PACK_HASH_MISMATCH");
    await writeFile(approvals, original);
    await expect(verifyHarnessAuditPack({ directory, signingKey: Buffer.alloc(32, 9) })).rejects.toThrow("AUDIT_PACK_KEY_MISMATCH");
    await writeFile(path.join(directory, "extra.json"), "{}\n");
    await expect(verifyHarnessAuditPack({ directory, signingKey: key })).rejects.toThrow("AUDIT_PACK_FILES_MISMATCH");
    await expect(loadAuditSigningKey({ value: "short" })).rejects.toThrow("AUDIT_PACK_KEY_INVALID");
    await expect(exportHarnessAuditPack({ store: memory([state()]), subjectId: "run-1", directory: path.join(root, "again"), signingKey: key, now: 1_700_000_000_000 })).resolves.toBeTruthy();
    await expect(exportHarnessAuditPack({ store: memory([state()]), subjectId: "missing", directory: path.join(root, "missing"), signingKey: key })).rejects.toThrow("AUDIT_PACK_SUBJECT_UNAVAILABLE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a guided task id packs every recorded run and a signed escape path is still rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit-pack-"));
  const scope = { tenantId: "local", namespace: "audit" };
  const taskId = "repair-task";
  const accountId = TaskBudget.accountId(scope, taskId);
  const runs = [state({ runId: "run-a", scope }), state({ runId: "run-b", scope })];
  const account = state({ runId: accountId, scope, metadata: { [TASK_BUDGET_ACCOUNT_KEY]: { schemaVersion: 2, taskId, runs: ["run-a", "run-b"], policy: {}, admissionsClosed: false } } });
  const directory = path.join(root, "task");
  try {
    const manifest = await exportHarnessAuditPack({ store: memory([account, ...runs]), scope, subjectId: taskId, directory, signingKey: key, now: 1_700_000_000_000 });
    expect(manifest.subject).toMatchObject({ kind: "task", id: taskId, runIds: ["run-a", "run-b"] });
    expect(manifest.files).toHaveLength(10);
    expect(manifest.files.some(file => file.path === "runs/run-a/usage-ledger.json")).toBe(true);
    const { signature, ...unsigned } = manifest;
    expect(canonicalizeAuditPackManifest(unsigned)).toContain("zhivex-harness-audit-pack");
    const escaped = JSON.parse(JSON.stringify(manifest)) as { files: Array<{ path: string }> };
    escaped.files.push({ path: "../outside.json", sha256: signature.value, bytes: 1 } as never);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(escaped));
    await expect(verifyHarnessAuditPack({ directory, signingKey: key })).rejects.toThrow("AUDIT_PACK_MANIFEST_INVALID");
    expect(createHash("sha256").update(key).digest("hex").startsWith(manifest.signature.keyId)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI accepts export-audit and verify-audit without widening stable option contracts", () => {
  expect(parseCliArgs(["export-audit", "task-1", "--out", "pack", "--session", "ses", "--json"])).toMatchObject({ command: "export-audit", runId: "task-1", auditOut: "pack", sessionId: "ses", json: true });
  expect(parseCliArgs(["verify-audit", "--out", "pack", "--signing-key-file", "key.bin"])).toMatchObject({ command: "verify-audit", auditOut: "pack", signingKeyFile: "key.bin" });
  expect(() => parseCliArgs(["export-audit", "--out", "pack"])).toThrow("requires a task id");
  expect(() => parseCliArgs(["verify-audit"])).toThrow("requires --out");
  expect(() => parseCliArgs(["run", "task", "--out", "pack"])).toThrow("supported only by export-audit");
  expect(() => parseCliArgs(["verify-audit", "--out", "pack", "--session", "ses"])).toThrow("not supported by verify-audit");
  expect(parseCliArgs(["export-audit", "--help"])).toMatchObject({ command: "help", helpTopic: "export-audit" });
});
