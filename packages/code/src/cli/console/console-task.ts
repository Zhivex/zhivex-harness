import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compileTaskAcceptanceContract, type TaskAcceptanceContract, type ZhivexHarness } from '@zhivex-ai/harness/engine';
import { nativeTaskSnapshot, resolvePackageCheckCommand, TASK_ACCEPTANCE_EVIDENCE_KEY } from '@zhivex-ai/harness/code-support';
import type { AgentRunState } from '@zhivex-ai/core';
import { sanitizeTerminalText } from '../terminal/terminal-ui.js';
import { consoleWorkspaceDiff } from './console-diff.js';

export const CODE_TASK_KEY = 'zhivexCodeTaskV1';
const briefSchema = z.strictObject({ goal: z.string().trim().min(1).max(2000), paths: z.array(z.string()).min(1).max(20),
  checks: z.array(z.string()).min(1).max(8), constraints: z.array(z.string().trim().min(1).max(500)).max(8).default([]) });
const taskSchema = z.strictObject({ schemaVersion: z.literal(1), goal: briefSchema.shape.goal,
  constraints: briefSchema.shape.constraints, contract: z.unknown(), baseline: z.record(z.string(), z.string()),
  keep: z.strictObject({ runId: z.string(), snapshotDigest: z.string(), at: z.number() }).optional() });
export interface CodeTask { schemaVersion: 1; goal: string; constraints: string[]; contract: TaskAcceptanceContract;
  baseline: Record<string, string>; keep?: { runId: string; snapshotDigest: string; at: number } | undefined }

export function restoredCodeTask(state?: Pick<AgentRunState, 'metadata'>): CodeTask | undefined {
  const raw = state?.metadata?.[CODE_TASK_KEY];
  if (raw === undefined) return undefined;
  const parsed = taskSchema.parse(raw);
  return { ...parsed, contract: compileTaskAcceptanceContract(parsed.contract).contract };
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
  const baseline: Record<string, string> = {};
  for (const path of contract.allowedWritePaths) {
    const file = await harness.workspace.readFile(path);
    if (file.truncated || Buffer.byteLength(file.content) > 64 * 1024) throw new Error('Guided tasks require selected existing text files at most 64 KiB each.');
    baseline[path] = file.digest;
  }
  const inspected = await harness.workspace.gitDiff();
  if ([inspected.status,inspected.diff,inspected.staged].some(result => result.exitCode !== 0 || result.timedOut || result.stdout.trim())) throw new Error('Git baseline changed during task preparation. Inspect your workspace before retrying.');
  return { schemaVersion: 1, goal: brief.goal, constraints: brief.constraints, contract, baseline };
}

export function codeTaskPrompt(task: CodeTask, prompt: string): string {
  return `Operator task goal: ${task.goal}\nConstraints: ${task.constraints.join('; ') || 'No additional constraints'}\n` +
    `Exact editable files: ${task.contract.allowedWritePaths.join(', ')}. Execute every declared check after the final edit. ` +
    `Passing checks leave human review pending; do not claim operator acceptance.\n\n${prompt}`;
}

export function codeTaskRecap(state?: AgentRunState): string {
  const task = restoredCodeTask(state);
  if (!task) return '';
  const raw = state!.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY];
  const evidence: any = raw && typeof raw === 'object' ? raw : {};
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  return sanitizeTerminalText(`Task: ${task.goal}\nConstraints: ${task.constraints.join('; ') || 'none'}\n` +
    `Files: ${task.contract.allowedWritePaths.join(', ')}\nAgent: ${state!.status} · task evidence: ${evidence.status ?? 'pending'}\n` +
    task.contract.requiredChecks.map(check => {
      const receipt = checks.find((item: any) => item.checkId === check.id);
      return `${check.kind === 'package-script' ? check.script : check.id}: ${!receipt ? 'no receipt' : `exit ${receipt.exitCode} · timeout ${receipt.timedOut} · unchanged ${receipt.unchanged}`}`;
    }).join('\n') + `\nHuman decision: ${task.keep?.runId === state!.runId ? 'kept at a reviewed snapshot; recheck current files with /task review' : 'pending'}\n` +
    'Next: /task review for fresh diff and evidence; /task keep after review, or /task revise <correction>.\n' +
    'Native checks run approved repository code on this host. Evidence covers selected files and package.json, not repository-wide isolation.\n');
}

export async function freshCodeTaskRecap(harness: ZhivexHarness, state?: AgentRunState): Promise<string> {
  const recap = codeTaskRecap(state), task = restoredCodeTask(state);
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
  if (evidence.contractDigest !== compileTaskAcceptanceContract(task.contract).digest) throw new Error('Task requirements changed outside this Code brief. No keep decision was saved; reconcile the engine contract first.');
  const ledger = { schemaVersion: 1 as const, revisions: [{ revision: 1, previousDigest: null, ...compileTaskAcceptanceContract(task.contract) }] };
  const current = await nativeTaskSnapshot(harness.workspace, ledger, state.runId);
  if (current.snapshotDigest !== evidence.delivery.snapshotDigest) throw new Error('Task evidence is stale: selected files or package.json changed. Revise and rerun checks.');
  const diff = await consoleWorkspaceDiff(harness.workspace);
  if (diff.startsWith('Git review unavailable')) throw new Error('Cannot keep without a current Git review.');
  if (!await confirm(codeTaskRecap(state) + diff)) return;
  if ((await nativeTaskSnapshot(harness.workspace, ledger, state.runId)).snapshotDigest !== current.snapshotDigest ||
      await consoleWorkspaceDiff(harness.workspace) !== diff) throw new Error('Files or Git review changed during review; no keep decision was saved.');
  await harness.store.save({ ...state, metadata: { ...state.metadata, [CODE_TASK_KEY]:
    JSON.parse(JSON.stringify({ ...task, keep: { runId: state.runId, snapshotDigest: current.snapshotDigest, at: Date.now() } })) } }, { expectedRevision: state.revision! });
}
