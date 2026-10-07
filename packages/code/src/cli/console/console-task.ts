import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compileTaskAcceptanceContract, reviseHarnessTaskAcceptance, type TaskAcceptanceContract, type ZhivexHarness } from '@zhivex-ai/harness/engine';
import { formatUsageLedger, initializeHarnessTaskBudget, inspectHarnessTaskBudget, inspectHarnessTaskContinuity, inspectTaskBudgetSummary, nativeTaskSnapshot, resolvePackageCheckCommand, TASK_ACCEPTANCE_EVIDENCE_KEY, TASK_BUDGET_KEY } from '@zhivex-ai/harness/code-support';
import type { AgentRunState } from '@zhivex-ai/core';
import { sanitizeTerminalText } from '../terminal/terminal-ui.js';
import { consoleWorkspaceDiff } from './console-diff.js';

export const CODE_TASK_KEY = 'zhivexCodeTaskV1';
const briefSchema = z.strictObject({ goal: z.string().trim().min(1).max(2000), paths: z.array(z.string()).min(1).max(20),
  checks: z.array(z.string()).min(1).max(8), budget: z.strictObject({ inputTokens: z.number().int().positive().safe(), outputTokens: z.number().int().positive().safe(), totalTokens: z.number().int().positive().safe() }).optional(), constraints: z.array(z.string().trim().min(1).max(500)).max(8).default([]) });
const taskSchema = z.strictObject({ schemaVersion: z.literal(1), goal: briefSchema.shape.goal,
  constraints: briefSchema.shape.constraints, contract: z.unknown(), baseline: z.record(z.string(), z.string()),
  budgetVersion: z.literal(1).optional(),
  keep: z.strictObject({ runId: z.string(), snapshotDigest: z.string(), at: z.number() }).optional() });
export interface CodeTask { schemaVersion: 1; goal: string; constraints: string[]; contract: TaskAcceptanceContract;
  baseline: Record<string, string>; budgetVersion?: 1 | undefined; keep?: { runId: string; snapshotDigest: string; at: number } | undefined }

export function restoredCodeTask(state?: Pick<AgentRunState, 'metadata'>): CodeTask | undefined {
  const raw = state?.metadata?.[CODE_TASK_KEY];
  if (raw === undefined) return undefined;
  const parsed = taskSchema.parse(raw);
  return { ...parsed, contract: compileTaskAcceptanceContract(parsed.contract).contract };
}

const execFileAsync = promisify(execFile);

async function requireGitVisibleTaskFiles(harness: ZhivexHarness, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      const { stdout } = await execFileAsync('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '-v', '-z', '--', path],
        { cwd: harness.workspace.root, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
      // H is a normal cached file; skip-worktree and assume-unchanged hide edits.
      if (stdout !== `H ${path}\0`) throw new Error('Selected file is hidden from Git review.');
    } catch {
      throw new Error(`Guided tasks require Git-tracked selected files visible to diff (no skip-worktree or assume-unchanged): ${path}`);
    }
  }
}

export async function prepareCodeTask(harness: ZhivexHarness, input: unknown): Promise<CodeTask> {
  if (harness.config.execution.backend !== 'none' || harness.config.orchestration.profiles.length) throw new Error('Guided /task currently supports the native backend without subagents.');
  const brief = briefSchema.parse(input);
  const diff = await harness.workspace.gitDiff();
  if ([diff.status, diff.diff, diff.staged].some(result => result.exitCode !== 0 || result.timedOut)) throw new Error('Start a guided task in a Git repository; /diff can explain unavailable Git evidence.');
  if ([diff.status, diff.diff, diff.staged].some(result => result.stdout.trim())) throw new Error('Task baseline requires a clean Git-visible workspace. Preserve existing changes yourself, or prepare a separate worktree before /task start.');
  const manifestFile = await harness.workspace.readFile('package.json');
  if (manifestFile.truncated) throw new Error('Task manifest must fit a complete workspace read.');
  const manifest = JSON.parse(manifestFile.content.replace(/^\d+: /gm, ''));
  const checks = await Promise.all(brief.checks.map(async (script, index) => {
    const expectedScript = manifest.scripts?.[script];
    if (typeof expectedScript !== 'string' || !expectedScript.trim() || expectedScript.length > 2000) throw new Error(`Task check ${script} must be an existing nonblank package script at most 2000 characters.`);
    const resolved = await resolvePackageCheckCommand(harness.workspace.root, manifest, script, expectedScript, harness.config.allowedChecks);
    return { id: `check-${index + 1}`, kind: 'package-script' as const, script, expectedScript,
      command: resolved.command[0], args: resolved.command.slice(1), purpose: `Check ${script} for: ${brief.goal}`.slice(0, 500),
      execution: { backend: 'none' as const, approval: 'required' as const } };
  }));
  const contract = compileTaskAcceptanceContract({ schemaVersion: 1, taskId: randomUUID(), allowedWritePaths: brief.paths,
    protectedFiles: ['package.json'], requiredChecks: checks,
    humanReview: [{ id: 'operator', requirement: brief.goal, status: 'pending' }, ...brief.constraints.map((requirement,index)=>({id:`constraint-${index+1}`,requirement,status:'pending'}))] }).contract;
  await requireGitVisibleTaskFiles(harness, contract.allowedWritePaths);
  const baseline: Record<string, string> = {};
  for (const path of contract.allowedWritePaths) {
    // inspectFile measures the full descriptor-bound source, without rendered line numbers.
    const file = await harness.workspace.inspectFile(path);
    if (file.bytes > 64 * 1024) throw new Error('Guided tasks require selected existing text files at most 64 KiB each.');
    // readFile retains the workspace text/binary checks; its preview may be truncated.
    if ((await harness.workspace.readFile(path)).digest !== file.digest) throw new Error('Task file changed during preparation. Retry with a stable baseline.');
    baseline[path] = file.digest;
  }
  const inspected = await harness.workspace.gitDiff();
  if ([inspected.status,inspected.diff,inspected.staged].some(result => result.exitCode !== 0 || result.timedOut || result.stdout.trim())) throw new Error('Git baseline changed during task preparation. Inspect your workspace before retrying.');
  await initializeHarnessTaskBudget(harness, contract.taskId, brief.budget);
  return { schemaVersion: 1, budgetVersion: 1, goal: brief.goal, constraints: brief.constraints, contract, baseline };
}

export function codeTaskPrompt(task: CodeTask, prompt: string): string {
  return `Operator task goal: ${task.goal}\nConstraints: ${task.constraints.join('; ') || 'No additional constraints'}\n` +
    `Exact editable files: ${task.contract.allowedWritePaths.join(', ')}. Execute every declared check after the final edit. ` +
    `Passing checks leave human review pending; do not claim operator acceptance.\n\n${prompt}`;
}

/** Recover only Code's append-only human correction; never infer a new scope or baseline. */
export async function recoverCodeTask(harness: ZhivexHarness, task: CodeTask): Promise<CodeTask> {
  if (task.budgetVersion !== 1) return task;
  const recovery = await inspectHarnessTaskContinuity(harness, task.contract.taskId);
  const current = recovery.currentContract;
  const digest = compileTaskAcceptanceContract(task.contract).digest;
  if (!current || current.digest === digest) return task;
  const history = recovery.runs.at(-1)!.ledger.revisions;
  const prior = history.findIndex(revision => revision.digest === digest);
  const requirements = current.contract.humanReview;
  const constraints = requirements.filter(item => item.id !== 'operator').map(item => item.requirement);
  if (prior < 0 || requirements.find(item => item.id === 'operator')?.requirement !== task.goal ||
    constraints.length <= task.constraints.length || constraints.length > 8 ||
    task.constraints.some((value, index) => constraints[index] !== value) ||
    requirements.filter(item => item.id !== 'operator').some((item, index) => item.status !== 'pending' || item.id !== `constraint-${index + 1}`) ||
    history.slice(prior + 1).some(revision => compileTaskAcceptanceContract({ ...revision.contract, humanReview: task.contract.humanReview }).digest !== digest)) {
    throw new Error('TASK_CONTINUITY_CONTRACT_CONFLICT');
  }
  return { ...task, constraints, contract: current.contract, keep: undefined };
}

/** An explicit operator correction revises existing durable authority before a new brief is used. */
export async function reviseCodeTask(harness: ZhivexHarness, task: CodeTask, correction: string): Promise<CodeTask> {
  if (!correction.trim() || correction.length > 500 || task.constraints.length >= 8) throw new Error('A correction must be 1–500 characters; at most 8 constraints are supported.');
  const next: CodeTask = { ...task, constraints: [...task.constraints, correction], keep: undefined,
    contract: { ...task.contract, humanReview: [{ id: 'operator', requirement: task.goal, status: 'pending' },
      ...[...task.constraints, correction].map((requirement, index) => ({ id: `constraint-${index + 1}`, requirement, status: 'pending' as const }))] } };
  const recovery = await inspectHarnessTaskContinuity(harness, task.contract.taskId);
  const latest = recovery.runs.at(-1);
  if (recovery.budget.runs.length && !latest) throw new Error('TASK_CONTINUITY_RUN_MISSING');
  if (latest) {
    if (recovery.currentContract?.digest !== compileTaskAcceptanceContract(task.contract).digest) throw new Error('TASK_CONTINUITY_CONTRACT_CONFLICT');
    await reviseHarnessTaskAcceptance(harness, { runId: latest.runId, expectedRunRevision: latest.revision!,
      expectedContractRevision: recovery.currentContract!.revision, contract: next.contract });
  }
  return { ...next, contract: compileTaskAcceptanceContract(next.contract).contract };
}

export function codeTaskBudgetRecap(value: unknown): string {
  const { monetary, monetaryDetails, cancellations, ...tokenSummary } = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const summary = inspectTaskBudgetSummary(tokenSummary);
  if (!summary) return 'Task budget: unavailable; further execution requires its established authority.\n';
  const cancellation = Array.isArray(cancellations) ? cancellations.at(-1) as Record<string, unknown> | undefined : undefined;
  const money = monetaryDetails && typeof monetaryDetails === 'object' ? monetaryDetails as Record<string, unknown> : undefined;
  const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6) : 'unknown';
  const tokens = (value: typeof summary.confirmed) => `input ${value.inputTokens}; output ${value.outputTokens}; total ${value.totalTokens}`;
  return sanitizeTerminalText(`Task budget authority: ${summary.accountRunId} · revision ${summary.revision}\n` +
    `Task token limits: ${tokens(summary.limits)}\nConfirmed: ${tokens(summary.confirmed)}\n` +
    `Reserved: ${tokens(summary.reserved)}\nUnknown consumption held: ${!summary.usageComplete ? 'unresolved actual usage; recorded exposure ' : ''}${tokens(summary.unknown)}\n` +
    `Task remaining: ${tokens(summary.remaining)}\n` +
    (summary.invocationPending ? `Retained invocation: ${summary.activeRunId ?? 'unresolved prior run'}; a new run cannot take over while its outcome remains pending.\n` : '') +
    `Task admission: ${summary.invocationPending ? 'blocked by a retained invocation; inspect the prior run' : !summary.usageComplete ? 'blocked by incomplete consumption; held reservations remain charged' : summary.admissionsClosed ? 'closed; explicit continuation required' : 'open subject to remaining budget'}\n` +
    (cancellation ? `Cancellation requested for ${String(cancellation.runId)}; ${cancellation.localExecution === 'native_tools_drained' ? 'native tool callbacks drained' : 'local execution unconfirmed'}. Provider stop unconfirmed; prior work and receipts retained. Task acceptance remains separate.\n` : '') +
    (monetary !== undefined ? `Task monetary ${formatUsageLedger(monetary)}\n` : '') +
    (money ? `Estimated confirmed USD ${amount(money.estimatedConfirmedUsd)}; reserved ${amount(money.reservedUsd)}; unknown exposure held ${amount(money.unknownHeldUsd)}; remaining ${amount(money.remainingUsd)}. Late receipts: ${typeof money.lateCalls === 'number' ? money.lateCalls : 'unknown'}.\n` : ''));
}

export async function freshCodeTaskBudgetRecap(harness: ZhivexHarness, task: CodeTask): Promise<string> {
  return codeTaskBudgetRecap(task.budgetVersion === 1 ? await inspectHarnessTaskBudget(harness, task.contract.taskId) : undefined);
}

export function codeTaskRecap(state?: AgentRunState, budgetSummary?: unknown): string {
  const task = restoredCodeTask(state);
  if (!task) return '';
  const raw = state!.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY];
  const evidence: any = raw && typeof raw === 'object' ? raw : {};
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  return sanitizeTerminalText(`Task: ${task.goal}\nConstraints: ${task.constraints.join('; ') || 'none'}\n` +
    `Files: ${task.contract.allowedWritePaths.join(', ')}\nAgent: ${state!.status} · task evidence: ${evidence.status ?? 'pending'}\n` +
    codeTaskBudgetRecap(budgetSummary ?? state!.metadata?.[TASK_BUDGET_KEY]) +
    task.contract.requiredChecks.map(check => {
      const receipt = checks.find((item: any) => item.checkId === check.id);
      return `${check.kind === 'package-script' ? check.script : check.id}: ${!receipt ? 'no receipt' : `exit ${receipt.exitCode} · timeout ${receipt.timedOut} · unchanged ${receipt.unchanged}`}`;
    }).join('\n') + `\nHuman decision: ${task.keep?.runId === state!.runId ? 'kept at a reviewed snapshot; recheck current files with /task review' : 'pending'}\n` +
    'Next: /task review for fresh diff and evidence; /task keep after review, or /task revise <correction>.\n' +
    'Native checks run approved repository code on this host. Evidence covers selected files and package.json, not repository-wide isolation.\n');
}

export async function freshCodeTaskRecap(harness: ZhivexHarness, state?: AgentRunState): Promise<string> {
  const task = restoredCodeTask(state);
  const budget = task?.budgetVersion === 1 ? await inspectHarnessTaskBudget(harness, task.contract.taskId) : undefined;
  const recap = codeTaskRecap(state, budget);
  if (task?.budgetVersion === 1) {
    const recovery = await inspectHarnessTaskContinuity(harness, task.contract.taskId);
    if (recovery.reasons.length) return recap.replace(/Next:[^\n]*\n/, 'Next: resolve continuity blockers using durable evidence; execution and keep remain blocked.\n') +
      `CONTINUITY BLOCKED: ${recovery.reasons.join(', ')}. Review durable evidence before execution or keep.\n`;
  }
  const evidence: any = state?.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY];
  if (task && evidence?.contractDigest && evidence.contractDigest !== compileTaskAcceptanceContract(task.contract).digest) {
    return recap + 'REQUIREMENTS CONFLICT: the engine contract differs from this Code brief. Keep is blocked; reconcile requirements before another task turn.\n';
  }
  if (!task || !state || !evidence?.delivery) return recap;
  try {
    const ledger = { schemaVersion: 1 as const, revisions: [{ revision: 1, previousDigest: null, ...compileTaskAcceptanceContract(task.contract) }] };
    const binding = await nativeTaskSnapshot(harness.workspace, ledger, state.runId);
    if (binding.snapshotDigest !== evidence.delivery.snapshotDigest) return recap + 'STALE EVIDENCE: selected files or package.json changed. Keep is blocked; revise and rerun checks.\n';
  } catch { return recap + 'EVIDENCE UNAVAILABLE: current files could not be inspected. Keep is blocked.\n'; }
  return recap;
}

/** Fresh inspection and CAS; no Git commit, reset, restore or model invocation. */
export async function keepCodeTask(harness: ZhivexHarness, state: AgentRunState, confirm: (review: string) => Promise<boolean>): Promise<void> {
  if (!Number.isSafeInteger(state.revision)) throw new Error('Task has no durable revision; reopen before review.');
  const task = restoredCodeTask(state);
  const evidence: any = state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY];
  if (!task || state.status !== 'completed' || evidence?.status !== 'pending_review' || !evidence.delivery) throw new Error('Task is not ready: every declared check must pass after the final edit and the agent must finish.');
  const validateContinuity = async () => {
    if (task.budgetVersion !== 1) throw new Error('TASK_CONTINUITY_BUDGET_REQUIRED');
    const recovery = await inspectHarnessTaskContinuity(harness, task.contract.taskId);
    const current = recovery.runs.at(-1);
    if (recovery.reasons.length || current?.runId !== state.runId || current.revision !== state.revision || current.checks.some(check => check.status !== 'confirmed'))
      throw new Error('TASK_CONTINUITY_REVIEW_BLOCKED: reload the current task and reconcile missing or stale evidence.');
    if (recovery.currentContract?.digest !== compileTaskAcceptanceContract(task.contract).digest) throw new Error('TASK_CONTINUITY_CONTRACT_CONFLICT');
  };
  await validateContinuity();
  if (evidence.contractDigest !== compileTaskAcceptanceContract(task.contract).digest) throw new Error('Task requirements changed outside this Code brief. No keep decision was saved; reconcile the engine contract first.');
  const ledger = { schemaVersion: 1 as const, revisions: [{ revision: 1, previousDigest: null, ...compileTaskAcceptanceContract(task.contract) }] };
  const current = await nativeTaskSnapshot(harness.workspace, ledger, state.runId);
  if (current.snapshotDigest !== evidence.delivery.snapshotDigest) throw new Error('Task evidence is stale: selected files or package.json changed. Revise and rerun checks.');
  await requireGitVisibleTaskFiles(harness, task.contract.allowedWritePaths);
  const diff = await consoleWorkspaceDiff(harness.workspace);
  if (diff.startsWith('Git review unavailable')) throw new Error('Cannot keep without a current Git review.');
  const budget = task.budgetVersion === 1 ? await inspectHarnessTaskBudget(harness, task.contract.taskId) : undefined;
  if (!await confirm(codeTaskRecap(state, budget) + diff)) return;
  await validateContinuity();
  if ((await nativeTaskSnapshot(harness.workspace, ledger, state.runId)).snapshotDigest !== current.snapshotDigest ||
      await consoleWorkspaceDiff(harness.workspace) !== diff) throw new Error('Files or Git review changed during review; no keep decision was saved.');
  await requireGitVisibleTaskFiles(harness, task.contract.allowedWritePaths);
  await harness.store.save({ ...state, metadata: { ...state.metadata, [CODE_TASK_KEY]:
    JSON.parse(JSON.stringify({ ...task, keep: { runId: state.runId, snapshotDigest: current.snapshotDigest, at: Date.now() } })) } }, { expectedRevision: state.revision! });
}
