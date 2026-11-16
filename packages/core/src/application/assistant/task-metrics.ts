import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const count = z.number().int().nonnegative().safe();
const amount = z.number().finite().nonnegative();
export const taskMetricsPricingSchema = z.strictObject({ schemaVersion: z.literal(1), prices: z.array(z.strictObject({
  provider: z.string().min(1).max(128), model: z.string().min(1).max(512),
  inputUsdPerMillion: amount, outputUsdPerMillion: amount,
  source: z.string().min(1).max(1024), asOf: z.string().datetime(), expiresAt: z.string().datetime()
})).max(100) }).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const price of value.prices) {
    const key = JSON.stringify([price.provider, price.model]);
    if (seen.has(key) || Date.parse(price.asOf) >= Date.parse(price.expiresAt)) context.addIssue({ code: 'custom', message: 'Duplicate model or invalid pricing interval' });
    seen.add(key);
  }
});
export const taskCategorySchema = z.enum(['general', 'agenda', 'calendar-change', 'preferences', 'daily-summary', 'recovery']);
export const taskFeedbackSchema = z.strictObject({
  taskId: id, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unverified']),
  category: taskCategorySchema,
});
export const taskLinkSchema = z.strictObject({ taskId: id, runId: id, kind: z.enum(['correction', 'continuation']) });
export const taskUsageSchema = z.object({ calls: count, inputTokens: amount, outputTokens: amount,
  usageComplete: z.boolean(), estimatedUsd: amount.nullable(),
  routes: z.array(z.object({ provider: z.string().max(128), model: z.string().max(512),
    calls: count, inputTokens: amount, outputTokens: amount, unknownCalls: count,
    estimatedUsd: amount.nullable(), priceStatuses: z.array(z.enum(['missing', 'stale', 'estimate'])) })).optional()
});
const runSchema = z.strictObject({ runId: id, sessionId: id, status: z.string().min(1).max(64),
  startedAt: count, updatedAt: count, usage: taskUsageSchema.nullable() });
export type TaskRunSnapshot = z.infer<typeof runSchema>;
type RunRow = { run_id: string; task_id: string; kind: string; snapshot: string };
type TaskRow = { id: string; category: z.infer<typeof taskCategorySchema>; outcome: 'success' | 'failure' | 'abandoned' | 'unverified'; reviewed_at: number | null; reviewed_revision: string | null };
const terminal = (status: string) => ['completed', 'failed', 'timed_out', 'cancelled', 'interrupted', 'max_steps', 'budget_exceeded'].includes(status);

/** Assistant-owned observations only. Never stores prompts, outputs, tool payloads or credentials. */
export async function openTaskMetrics(directory: string, now = Date.now) {
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error('METRICS_DIRECTORY_UNSAFE');
  const filename = path.join(directory, 'task-metrics.sqlite');
  try { const file = await open(filename, 'wx', 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const file = await open(filename + suffix, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const s = await file.stat(); if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('METRICS_FILE_UNSAFE'); }
      finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(filename);
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version !== 0 && version !== 1) throw new Error('METRICS_VERSION_UNSUPPORTED');
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT 'general',
        outcome TEXT NOT NULL DEFAULT 'unverified', reviewed_at INTEGER, reviewed_revision TEXT);
      CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL DEFAULT 'initial', snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      PRAGMA user_version=1;`);
  } catch (error) { db.close(); throw error; }
  const transaction = <T>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const rows = () => db.prepare('SELECT * FROM runs ORDER BY run_id').all() as RunRow[];
  const task = (taskId: string) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as TaskRow | undefined;
    if (!row) throw new Error('METRICS_TASK_NOT_FOUND');
    const runs = (db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY run_id').all(taskId) as RunRow[])
      .map(r => ({ ...runSchema.parse(JSON.parse(r.snapshot)), kind: r.kind }));
    const revision = createHash('sha256').update(JSON.stringify(runs)).digest('hex');
    const settled = runs.length > 0 && runs.every(r => terminal(r.status));
    const startedAt = Math.min(...runs.map(r => r.startedAt));
    const endedAt = settled ? Math.max(...runs.map(r => r.updatedAt)) : null;
    const costComplete = settled && runs.every(r => r.usage?.usageComplete && r.usage.estimatedUsd !== null);
    const currentReview = row.reviewed_revision === revision;
    return { taskId, revision, category: row.category, outcome: currentReview ? row.outcome : 'unverified' as const,
      verification: currentReview && row.outcome !== 'unverified' ? 'operator' as const : null,
      reviewedAt: row.reviewed_at, startedAt, endedAt,
      durationMs: endedAt === null ? null : Math.max(0, endedAt - startedAt),
      elapsedMs: Math.max(0, (endedAt ?? now()) - startedAt),
      corrections: runs.filter(r => r.kind === 'correction').length,
      runCount: runs.length, usageComplete: runs.every(r => r.usage?.usageComplete === true),
      inputTokens: runs.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0),
      outputTokens: runs.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0),
      estimatedUsd: costComplete ? runs.reduce((n, r) => n + r.usage!.estimatedUsd!, 0) : null,
      costComplete, costKind: 'estimate-not-invoice' as const, runs };
  };
  return {
    observe(input: TaskRunSnapshot) {
      const value = runSchema.parse(input);
      transaction(() => {
        const existing = db.prepare('SELECT * FROM runs WHERE run_id=?').get(value.runId) as RunRow | undefined;
        if (existing) {
          const previous = runSchema.parse(JSON.parse(existing.snapshot));
          if (previous.sessionId !== value.sessionId) throw new Error('METRICS_SESSION_MISMATCH');
          if (value.updatedAt < previous.updatedAt) return;
          value.startedAt = Math.min(previous.startedAt, value.startedAt);
        } else db.prepare('INSERT INTO tasks(id) VALUES(?)').run(value.runId);
        db.prepare(`INSERT INTO runs(run_id,task_id,snapshot) VALUES(?,?,?)
          ON CONFLICT(run_id) DO UPDATE SET snapshot=excluded.snapshot`).run(value.runId, value.runId, JSON.stringify(value));
      });
    },
    references: () => rows().map(r => { const s = runSchema.parse(JSON.parse(r.snapshot)); return { runId: s.runId, sessionId: s.sessionId }; }),
    get: task,
    link(input: unknown) {
      const value = taskLinkSchema.parse(input);
      return transaction(() => {
        const destination = task(value.taskId);
        const row = db.prepare('SELECT * FROM runs WHERE run_id=?').get(value.runId) as RunRow | undefined;
        if (!row) throw new Error('METRICS_RUN_NOT_FOUND');
        if (row.task_id === value.taskId && row.kind === value.kind) return task(value.taskId);
        const source = task(row.task_id);
        if (source.runCount !== 1 || row.task_id === value.taskId || source.reviewedAt !== null ||
            source.runs[0]!.sessionId !== destination.runs[0]!.sessionId || source.startedAt < destination.startedAt) throw new Error('METRICS_LINK_INVALID');
        db.prepare('UPDATE runs SET task_id=?, kind=? WHERE run_id=?').run(value.taskId, value.kind, value.runId);
        db.prepare('DELETE FROM tasks WHERE id=?').run(row.task_id);
        return task(value.taskId);
      });
    },
    feedback(input: unknown) {
      const value = taskFeedbackSchema.parse(input);
      return transaction(() => {
        const current = task(value.taskId);
        if (current.revision !== value.expectedRevision) throw new Error('METRICS_REVIEW_STALE');
        if (current.endedAt === null && value.outcome !== 'unverified') throw new Error('METRICS_TASK_PENDING');
        db.prepare('UPDATE tasks SET category=?,outcome=?,reviewed_at=?,reviewed_revision=? WHERE id=?')
          .run(value.category, value.outcome, now(), current.revision, value.taskId);
        return task(value.taskId);
      });
    },
    report() {
      const tasks = (db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[]).map(row => task(row.id));
      const success = tasks.filter(t => t.outcome === 'success').length;
      const evaluated = tasks.filter(t => t.outcome !== 'unverified').length;
      const costComplete = tasks.length > 0 && tasks.every(t => t.costComplete);
      const totalEstimatedUsd = costComplete ? tasks.reduce((n, t) => n + t.estimatedUsd!, 0) : null;
      return { schemaVersion: 1 as const, generatedAt: now(), tasks,
        summary: { tasks: tasks.length, evaluated, success, unverified: tasks.length - evaluated,
          verifiedSuccessRate: evaluated ? success / evaluated : null,
          verificationCoverage: tasks.length ? evaluated / tasks.length : null,
          corrections: tasks.reduce((n, t) => n + t.corrections, 0),
          totalEstimatedUsd, costComplete,
          estimatedUsdPerSuccess: success && totalEstimatedUsd !== null ? totalEstimatedUsd / success : null } };
    },
    close() { db.close(); }
  };
}
export type TaskMetrics = Awaited<ReturnType<typeof openTaskMetrics>>;
