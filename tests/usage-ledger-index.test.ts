import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { UsageLedger, runUsageLedgerWithPolicy } from "../src/runtime/usage-ledger.js";
import { openCliSessionStore } from "../src/persistence/sessions.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";

test("reopening an RC6 ledger creates the scope/run index without changing receipts or route order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "har-ledger-index-"));
  const config = resolveHarnessConfig({ workspace: root });
  let ledger = await UsageLedger.open(config, { limitUsd: 1 });
  let database: SqliteDatabase | undefined;
  try {
    await ledger.run("target", async () => {});
    const sessions = await openCliSessionStore({ workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope });
    const key = `${sessions.workspaceKey}:${sessions.scopeKey}`;
    const databasePath = sessions.databasePath;
    database = new SqliteDatabase(databasePath);
    sessions.close();
    database.exec("DROP INDEX zhivex_usage_calls_scope_run");
    // Reconstruct the actual pre-upgrade table rather than inserting old positional rows into the new schema.
    database.exec("ALTER TABLE zhivex_usage_calls DROP COLUMN category");
    database.exec("ALTER TABLE zhivex_usage_calls DROP COLUMN late_receipt");
    database.query(`INSERT INTO zhivex_usage_calls VALUES
      ('target-first', ?1, 'target', 'b', 'model', 'confirmed', 10, 5, 0.01, 0.02, 'estimate'),
      ('target-second', ?1, 'target', 'a', 'model', 'unknown', NULL, NULL, NULL, 0.03, 'missing'),
      ('target-third', ?1, 'target', 'b', 'model', 'confirmed', 20, 7, 0.02, 0.02, 'estimate')`).run(key);
    database.query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
      INSERT INTO zhivex_usage_calls SELECT 'foreign-'||i, CASE WHEN i%2=0 THEN ?1 ELSE 'foreign' END,
      CASE WHEN i%2=0 THEN 'other-run' ELSE 'target' END, 'c', 'model', 'confirmed', 999, 999, 10, 10, 'estimate' FROM n`).run(key);
    const before = ledger.summary("target");
    ledger.close();
    ledger = await UsageLedger.open(config, { limitUsd: 100 });
    const after = ledger.summary("target");
    database.close();
    database = new SqliteDatabase(databasePath);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ calls: 3, inputTokens: 30, outputTokens: 12, usageComplete: false, estimatedUsd: null, limitUsd: 1 });
    expect(after.routes.map(route => route.provider)).toEqual(["b", "a"]);
    const plan = database.query<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM zhivex_usage_calls WHERE scope_key=?1 AND run_id=?2 ORDER BY rowid").all(key, "target");
    expect(plan.some(row => row.detail.includes("zhivex_usage_calls_scope_run"))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    ledger.close();
    ledger = await UsageLedger.open(config);
    expect(ledger.summary("target")).toEqual(after);
  } finally {
    database?.close(); ledger.close(); await rm(root, { recursive: true, force: true });
  }
});

test("each summary reads its persisted policy once, including historical unknown usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "har-ledger-policy-"));
  const ledger = await UsageLedger.open(resolveHarnessConfig({ workspace: root }), { limitUsd: 1 });
  try {
    await ledger.run("legacy", async () => {}, true);
    const queries = spyOn(SqliteDatabase.prototype, "query");
    try {
      expect(ledger.summary("legacy")).toMatchObject({ calls: 0, historicalUsageUnknown: true, usageComplete: false, estimatedUsd: null, limitUsd: 1 });
      expect(queries.mock.calls.filter(([sql]) => sql.includes("SELECT policy FROM zhivex_usage_policies"))).toHaveLength(1);
    } finally { queries.mockRestore(); }
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("a task-supplied initial policy is validated and frozen before the operation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "har-ledger-initial-policy-"));
  const ledger = await UsageLedger.open(resolveHarnessConfig({ workspace: root }), { limitUsd: 100 });
  try {
    for (const limitUsd of [0, -1, NaN, Infinity]) {
      let invoked = false;
      await expect(runUsageLedgerWithPolicy(ledger, "invalid", async () => { invoked = true; }, false, { limitUsd })).rejects.toThrow("Usage limit must be positive USD");
      expect(invoked).toBe(false);
    }
    expect(() => ledger.assertResume("invalid")).toThrow("USAGE_LEDGER_MISSING");
    await runUsageLedgerWithPolicy(ledger, "task", async () => {
      expect(ledger.summary("task").limitUsd).toBe(1);
    }, false, { limitUsd: 1, requireCompleteUsage: true });
    await runUsageLedgerWithPolicy(ledger, "task", async () => {
      expect(ledger.summary("task").limitUsd).toBe(1);
    }, false, { limitUsd: 100 });
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("internal task policy admission stays scoped across nested and concurrent run owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "har-ledger-policy-scope-"));
  const ledger = await UsageLedger.open(resolveHarnessConfig({ workspace: root }), { limitUsd: 100 });
  try {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const first = runUsageLedgerWithPolicy(ledger, "first", async () => {
      await ledger.run("ordinary", async () => {
        expect(ledger.summary("ordinary").limitUsd).toBe(100);
      });
      await waiting;
      expect(ledger.summary("first").limitUsd).toBe(1);
    }, false, { limitUsd: 1 });
    await runUsageLedgerWithPolicy(ledger, "second", async () => {
      expect(ledger.summary("second").limitUsd).toBe(2);
      release();
    }, false, { limitUsd: 2 });
    await first;
    await ledger.run("later", async () => {
      expect(ledger.summary("later").limitUsd).toBe(100);
    });
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});
