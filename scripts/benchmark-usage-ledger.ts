/** Offline RC6/candidate local-overhead probe. Never calls a provider. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { UsageLedger } from "../src/runtime/usage-ledger.js";
import { openHarnessActivityStore } from "../src/client/service-events.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { openCliSessionStore } from "../src/persistence/sessions.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";

const RC6 = "0adf4e2e96380864ef4c697ea94df64ad7c18eec";
const args = process.argv.slice(2);
const baselineRoot = args[args.indexOf("--baseline-root") + 1];
if (!args.includes("--baseline-root") || !baselineRoot) throw new Error("Provide --baseline-root <clean RC6 checkout>.");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: baselineRoot, encoding: "utf8" }).trim(), RC6);
assert.equal(execFileSync("git", ["status", "--porcelain", "--", "src/runtime/usage-ledger.ts", "src/client/service-events.ts"], { cwd: baselineRoot, encoding: "utf8" }).trim(), "", "RC6 measured source must be clean");
const baselineLedger = (await import(pathToFileURL(path.join(baselineRoot, "src/runtime/usage-ledger.ts")).href)).UsageLedger as typeof UsageLedger;
const baselineActivity = (await import(pathToFileURL(path.join(baselineRoot, "src/client/service-events.ts")).href)).openHarnessActivityStore as typeof openHarnessActivityStore;
const INDEX = "CREATE INDEX IF NOT EXISTS zhivex_usage_calls_scope_run ON zhivex_usage_calls(scope_key, run_id)";
const milliseconds = (operation: () => unknown) => { const start = performance.now(); operation(); return performance.now() - start; };
const sample = (operation: () => unknown, repetitions: number) => {
  for (let i = 0; i < 5; i++) operation();
  const values = Array.from({ length: repetitions }, () => milliseconds(operation)).sort((a, b) => a - b);
  return { repetitions, p50Ms: values[Math.floor(values.length / 2)]!, p95Ms: values[Math.floor(values.length * 0.95)]! };
};
const bytes = (database: SqliteDatabase) => database.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count * database.query<{ page_size: number }>("PRAGMA page_size").get()!.page_size;

async function fixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = resolveHarnessConfig({ workspace: root });
  const sessions = await openCliSessionStore({ workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope });
  const key = `${sessions.workspaceKey}:${sessions.scopeKey}`, databasePath = sessions.databasePath;
  sessions.close();
  return { root, config, key, databasePath };
}

async function ledgerProbe(indexed: boolean, foreignRows: number) {
  const f = await fixture("har-ledger-probe-");
  let ledger = await baselineLedger.open(f.config, { limitUsd: 1 });
  let database: SqliteDatabase | undefined;
  try {
    await ledger.run("target", async () => {});
    database = new SqliteDatabase(f.databasePath);
    database.query(`INSERT INTO zhivex_usage_calls VALUES
      ('target-b', ?1, 'target', 'b', 'model', 'confirmed', 10, 5, 0.01, 0.02, 'estimate'),
      ('target-a', ?1, 'target', 'a', 'model', 'unknown', NULL, NULL, NULL, 0.03, 'missing'),
      ('target-b2', ?1, 'target', 'b', 'model', 'confirmed', 20, 7, 0.02, 0.02, 'estimate')`).run(f.key);
    if (foreignRows) database.query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?2)
      INSERT INTO zhivex_usage_calls SELECT 'foreign-'||i, CASE WHEN i%2=0 THEN ?1 ELSE 'foreign-scope' END,
      CASE WHEN i%2=0 THEN 'other-run' ELSE 'target' END, 'c', 'model', 'confirmed', 999, 999, 10, 10, 'estimate' FROM n`).run(f.key, foreignRows);
    const before = ledger.summary("target");
    ledger.close();
    const beforeBytes = bytes(database);
    let creationMs = 0;
    let blockedCreationMs: number | null = null, blockedError: string | null = null;
    if (indexed) {
      const blocker = new SqliteDatabase(f.databasePath);
      database.exec("PRAGMA busy_timeout=0");
      try {
        blocker.exec("BEGIN IMMEDIATE");
        const start = performance.now();
        try { database.exec(INDEX); throw new Error("Index creation unexpectedly bypassed the writer lock."); }
        catch (error) {
          blockedCreationMs = performance.now() - start;
          blockedError = String(error);
          assert.match(blockedError, /locked|busy/i);
        }
      } finally { blocker.exec("ROLLBACK"); blocker.close(); }
      creationMs = milliseconds(() => database!.exec(INDEX));
    }
    const afterBytes = bytes(database);
    database.close(); database = undefined;
    const start = performance.now();
    ledger = await (indexed ? UsageLedger : baselineLedger).open(f.config, { limitUsd: 100 });
    const reopenMs = performance.now() - start;
    const summary = ledger.summary("target");
    assert.deepEqual(summary, before, "Index/policy-read changes must preserve receipt totals, unknowns, frozen policy and route ordering");
    const summaryTiming = sample(() => ledger.summary("target"), 100);
    database = new SqliteDatabase(f.databasePath);
    const queryPlan = database.query<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM zhivex_usage_calls WHERE scope_key=?1 AND run_id=?2 ORDER BY rowid").all(f.key, "target").map(row => row.detail);
    if (indexed) assert(queryPlan.some(detail => detail.includes("zhivex_usage_calls_scope_run")));
    const insert = database.query("INSERT INTO zhivex_usage_calls VALUES (?1,?2,'other-run','c','model','confirmed',1,1,0.01,0.01,'estimate')");
    const appendBatchMs = milliseconds(() => {
      database!.exec("BEGIN IMMEDIATE");
      try { for (let i = 0; i < 200; i++) insert.run(`append-${i}`, f.key); database!.exec("COMMIT"); }
      catch (error) { database!.exec("ROLLBACK"); throw error; }
    });
    return { variant: indexed ? "candidate" : "RC6", foreignRows, summary, summaryTiming, creationMs, allocatedBytesBefore: beforeBytes, allocatedBytesAfter: afterBytes, indexAllocatedBytes: afterBytes - beforeBytes, reopenMs, blockedCreationMs, blockedError, appendBatchRows: 200, appendBatchMs, queryPlan };
  } finally { database?.close(); ledger.close(); await rm(f.root, { recursive: true, force: true }); }
}

async function activityProbe(candidate: boolean, large: boolean) {
  const f = await fixture("har-activity-probe-");
  const started = performance.now();
  const store = await (candidate ? openHarnessActivityStore : baselineActivity)(f.config, { maxEvents: 100_000, now: () => 1234 });
  const openMs = performance.now() - started;
  let closed = false;
  try {
    if (large) {
      const database = new SqliteDatabase(f.databasePath);
      try {
        const runs = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`r${i}`, { text: "a".repeat(256 * 1024), status: "completed", truncated: false }]));
        database.query("INSERT INTO client_activity_snapshots(scope,session,sequence,snapshot) VALUES (?,?,?,?)").run(f.key, "session", 0, JSON.stringify({ schemaVersion: 1, sessionId: "session", sequence: 0, runs }));
      } finally { database.close(); }
    }
    store.checkpoint("session", "r0", "completed");
    const append = sample(() => store.checkpoint("session", "r0", "completed"), 30);
    const cursor = store.replay("session").nextCursor;
    const idleReplay = sample(() => { assert.equal(store.replay("session", cursor).events.length, 0); }, 50);
    const replay = store.replay("session");
    assert.equal(replay.events.length, 36);
    assert(replay.events.every(event => event.activity.type === "checkpoint" && event.activity.status === "completed"));
    store.close(); closed = true;
    const reopened = await (candidate ? openHarnessActivityStore : baselineActivity)(f.config, { maxEvents: 100_000, now: () => 1234 });
    try { assert.deepEqual(reopened.replay("session"), replay); } finally { reopened.close(); }
    return { variant: candidate ? "candidate" : "RC6", snapshotTextBytes: large ? 6 * 256 * 1024 : 0, openMs, append, idleReplay, replayEvents: replay.events.length, restartEquivalent: true };
  } finally { if (!closed) store.close(); await rm(f.root, { recursive: true, force: true }); }
}

const trials = [];
for (let trial = 1; trial <= 3; trial++) {
  // Alternate order to reduce a consistent cache/thermal advantage.
  const variants = trial % 2 ? [false, true] : [true, false];
  const ledger = [], activity = [];
  for (const indexed of variants) for (const rows of [0, 100_000]) ledger.push(await ledgerProbe(indexed, rows));
  for (const candidate of variants) for (const large of [false, true]) activity.push(await activityProbe(candidate, large));
  trials.push({ trial, ledger, activity });
}
const sourceDigests: Record<string, Record<string, string>> = {};
for (const [variant, root] of [["RC6", baselineRoot], ["candidate", process.cwd()]] as const) {
  sourceDigests[variant] = {};
  for (const file of ["src/runtime/usage-ledger.ts", "src/client/service-events.ts"]) {
    sourceDigests[variant]![file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
}
console.log(JSON.stringify({ schemaVersion: 1, baselineSha: RC6, candidateHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), candidateIncludesWorkingTreeChanges: true, sourceDigests, runtime: { hostNodeVersion: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(), processVersion: process.version, executable: process.execPath, bun: Bun.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() }, clock: "performance.now monotonic", trials, limits: "Synthetic local overhead only; same process/machine/fixtures; no model-quality or end-to-end speed claim; lock probe uses timeout 0 rather than measuring the production 5s deadline" }, null, 2));
