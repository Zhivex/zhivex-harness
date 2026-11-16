import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { ZhivexHarness } from '../runtime/harness.js';
import { compileTaskAcceptanceContract } from '../runtime/task-acceptance.js';
import { readTaskAcceptanceLedger } from '../runtime/task-acceptance-record.js';
import { initializeHarnessTaskBudget, openHarnessTaskBudget } from '../runtime/task-budget-host.js';
import { readTaskContinuityEvidence } from '../runtime/task-continuity.js';
import { resolvePackageCheckCommand } from '../execution/package-manager.js';
import type { HarnessTaskProjection } from './task-projection.js';
import { nextTaskAcceptanceLedger, TASK_ACCEPTANCE_KEY } from '../runtime/task-acceptance-record.js';
import { TASK_BUDGET_KEY } from '../runtime/task-budget.js';
import { captureTaskSources, TASK_SOURCE_KEY } from '../context/task-memory.js';
import type { AgentRunState } from '@zhivex-ai/core';

const exec = promisify(execFile);
export const TASK_HUMAN_DECISION_KEY = 'harnessClientHumanDecisionV1';
export interface TaskBrief {
  goal: string; paths: string[]; checks: string[]; constraints: string[];
  budget: { inputTokens: number; outputTokens: number; totalTokens: number };
}
const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const taskReviewIdentity = (p: HarnessTaskProjection) => hash(p.task);
export async function taskHumanDecision(host: ZhivexHarness, p: HarnessTaskProjection) {
  const state = await host.store.load(p.task.observedRunId, host.config.scope);
  const raw = state?.metadata?.[TASK_HUMAN_DECISION_KEY] as Record<string, unknown> | undefined;
  if (!raw || raw.schemaVersion !== 1 || raw.kind !== 'accepted' || raw.provenance !== 'explicit_operator_review' ||
    typeof raw.at !== 'number') return { status: 'not_recorded' as const, at: null, provenance: null };
  return { status: raw.runId === p.task.observedRunId && raw.contractDigest === p.task.contractDigest &&
    raw.snapshotDigest === p.task.artifact.observedDigest && p.task.review.structure === 'verified' ? 'current' as const : 'stale' as const,
    at: raw.at, provenance: 'explicit_operator_review' as const };
}
export async function visibleTaskFiles(host: ZhivexHarness, paths: readonly string[]) {
  for (const file of paths) {
    const result = await exec('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '-v', '-z', '--', file],
      { cwd: host.workspace.root, timeout: 10000, maxBuffer: 65536 });
    if (result.stdout !== 'H ' + file + '\0') throw new Error('TASK_FILES_UNAVAILABLE');
  }
}
export async function taskGitReview(host: ZhivexHarness) {
  const result = await host.workspace.gitDiff();
  if ([result.status, result.diff, result.staged].some(r => r.exitCode !== 0 || r.timedOut || r.stdout.length >= 20000))
    throw new Error('TASK_DIFF_UNAVAILABLE');
  const text = result.diff.stdout + result.staged.stdout;
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('TASK_DIFF_CAPACITY');
  return { text, identity: hash([result.status.stdout, result.diff.stdout, result.staged.stdout]) };
}
/** Browser supplies a bounded operator brief, never a contract, receipt or execution grant. */
export async function prepareClientTask(host: ZhivexHarness, brief: TaskBrief) {
  if (host.config.execution.backend !== 'none' || host.config.orchestration.profiles.length || host.agent.subagents?.length)
    throw new Error('TASK_HOST_UNSUPPORTED');
  const clean = async () => {
    const git = await host.workspace.gitDiff();
    if ([git.status, git.diff, git.staged].some(r => r.exitCode !== 0 || r.timedOut || r.stdout.trim()))
      throw new Error('TASK_CLEAN_BASELINE_REQUIRED');
  };
  await clean();
  const file = await host.workspace.readFile('package.json');
  if (file.truncated) throw new Error('TASK_MANIFEST_UNAVAILABLE');
  const manifest = JSON.parse(file.content.replace(/^\d+: /gm, ''));
  const requiredChecks = await Promise.all(brief.checks.map(async (script, index) => {
    const expectedScript = manifest.scripts?.[script];
    if (typeof expectedScript !== 'string' || !expectedScript.trim() || expectedScript.length > 2000)
      throw new Error('TASK_CHECK_UNAVAILABLE');
    const resolved = await resolvePackageCheckCommand(host.workspace.root, manifest, script, expectedScript, host.config.allowedChecks);
    return { id: 'check-' + (index + 1), kind: 'package-script' as const, script, expectedScript,
      command: resolved.command[0], args: resolved.command.slice(1), purpose: ('Check ' + script + ' for: ' + brief.goal).slice(0, 500),
      execution: { backend: 'none' as const, approval: 'required' as const } };
  }));
  const contract = compileTaskAcceptanceContract({ schemaVersion: 1, taskId: randomUUID(),
    allowedWritePaths: brief.paths, protectedFiles: ['package.json'], requiredChecks,
    humanReview: [{ id: 'operator', requirement: brief.goal, status: 'pending' },
      ...brief.constraints.map((requirement, index) => ({ id: 'constraint-' + (index + 1), requirement, status: 'pending' }))] }).contract;
  await visibleTaskFiles(host, contract.allowedWritePaths);
  const baseline: Record<string, string> = {};
  for (const path of contract.allowedWritePaths) {
    const inspected = await host.workspace.inspectFile(path);
    if (inspected.bytes > 65536 || (await host.workspace.readFile(path)).digest !== inspected.digest) throw new Error('TASK_FILE_UNAVAILABLE');
    baseline[path] = inspected.digest;
  }
  await clean();
  await initializeHarnessTaskBudget(host, contract.taskId, brief.budget);
  return { schemaVersion: 1 as const, budgetVersion: 1 as const, goal: brief.goal, constraints: brief.constraints, contract, baseline };
}

export async function currentClientTask(host: ZhivexHarness, runId: string, allowedRunIds: readonly string[]) {
  const state = await host.store.load(runId, host.config.scope);
  const ledger = state && readTaskAcceptanceLedger(state);
  if (!state || !ledger) throw new Error('TASK_CONTRACT_UNAVAILABLE');
  const taskId = ledger.revisions.at(-1)!.contract.taskId;
  const evidence = await readTaskContinuityEvidence(host, taskId, { allowedRunIds });
  const latest = evidence.report.runs.at(-1), current = evidence.report.currentContract;
  if (!current || latest?.runId !== runId || latest.revision !== state.revision) throw new Error('TASK_REVIEW_CHANGED');
  return { state, ledger, evidence, current, taskId };
}

/** Record a host preparation failure before any model invocation, retaining the original account.
 * If authority cannot be acquired, the caller must leave the durable draft blocked, never downgrade to chat. */
export async function persistClientTaskPreparationFailure(host: ZhivexHarness, state: AgentRunState,
  contract: ReturnType<typeof compileTaskAcceptanceContract>['contract']) {
  const account = await openHarnessTaskBudget(host, contract.taskId);
  const before = await readTaskContinuityEvidence(host, contract.taskId);
  const ledger = before.report.runs.at(-1)?.ledger ?? nextTaskAcceptanceLedger(undefined, contract);
  if (ledger.revisions.at(-1)!.digest !== compileTaskAcceptanceContract(contract).digest) throw new Error('TASK_REVIEW_CHANGED');
  await account.run(state.runId, async () => {
    await before.verify();
    const summary = await account.summary();
    await host.store.save({ ...state, ...(host.agent.harness ? { harness: host.agent.harness } : {}),
      metadata: { ...state.metadata, [TASK_ACCEPTANCE_KEY]: JSON.parse(JSON.stringify(ledger)),
        [TASK_BUDGET_KEY]: JSON.parse(JSON.stringify(summary)),
        [TASK_SOURCE_KEY]: captureTaskSources(state.metadata, state.messages) } }, { expectedRevision: 0 });
  });
}

/** Account exclusion is the same exclusion used for task admission; run CAS alone is insufficient. */
export async function keepClientTask(host: ZhivexHarness, runId: string, allowedRunIds: readonly string[],
  expected: { runRevision: number; contractDigest: string; snapshotDigest: string; budgetRevision: number; gitIdentity: string }) {
  const initial = await currentClientTask(host, runId, allowedRunIds);
  const account = await openHarnessTaskBudget(host, initial.taskId);
  const ownerId = randomUUID();
  if (!await host.store.acquireLease!(account.accountRunId, { ownerId, ttlMs: 30000 }, host.config.scope)) throw new Error('TASK_REVIEW_BUSY');
  try {
    const { state, evidence, current } = await currentClientTask(host, runId, allowedRunIds);
    const latest = evidence.report.runs.at(-1)!;
    if (state.revision !== expected.runRevision || current.digest !== expected.contractDigest ||
      evidence.report.budget?.revision !== expected.budgetRevision || state.status !== 'completed' ||
      evidence.report.reasons.length || latest.checks.some(c => c.status !== 'confirmed') ||
      latest.snapshot?.snapshotDigest !== expected.snapshotDigest ||
      (latest.delivery as { snapshotDigest?: string } | null)?.snapshotDigest !== expected.snapshotDigest)
      throw new Error('TASK_REVIEW_CHANGED');
    await visibleTaskFiles(host, current.contract.allowedWritePaths);
    if ((await taskGitReview(host)).identity !== expected.gitIdentity) throw new Error('TASK_REVIEW_CHANGED');
    await evidence.verifyAll();
    if (!await host.store.renewLease!(account.accountRunId, { ownerId, ttlMs: 30000 }, host.config.scope)) throw new Error('TASK_REVIEW_BUSY');
    const decision = { schemaVersion: 1, kind: 'accepted', runId, contractDigest: current.digest,
      contractRevision: current.revision, snapshotDigest: expected.snapshotDigest, reviewedRunRevision: expected.runRevision,
      at: Date.now(), provenance: 'explicit_operator_review' };
    await host.store.save({ ...state, metadata: { ...state.metadata, [TASK_HUMAN_DECISION_KEY]: decision } },
      { expectedRevision: state.revision! });
    return decision;
  } finally { await host.store.releaseLease!(account.accountRunId, ownerId, host.config.scope); }
}
