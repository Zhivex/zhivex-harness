import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ToolSet } from '@zhivex-ai/core';
import type { Workspace } from '../workspace/workspace.js';
import type { TaskAcceptanceLedger } from './task-acceptance-record.js';
import { confirmTaskAcceptanceImport, taskAcceptanceChecks, withTaskAcceptanceDelivery } from './task-acceptance-delivery.js';
import type { TaskCheckBinding } from './task-acceptance-checks.js';

const scopes = new AsyncLocalStorage<{ workspace: Workspace; ledger: TaskAcceptanceLedger; runId: string }>();
const readTools = new Set(['list_files', 'read_file', 'read_files', 'read_dependency', 'search_files', 'search_many',
  'propose_edits', 'mutation_audit', 'git_diff', 'read_task', 'repair_plan']);
const editTools = new Set(['apply_patch', 'apply_reviewed_edits', 'apply_reviewed_replacement']);

/** Native evidence covers these exact files, not a sandbox or the entire repository. */
export async function nativeTaskSnapshot(workspace: Workspace, ledger: TaskAcceptanceLedger, runId: string): Promise<TaskCheckBinding> {
  const contract = ledger.revisions.at(-1)!.contract;
  const paths = [...new Set([...contract.allowedWritePaths, ...contract.protectedFiles, 'package.json'])].sort();
  const files = await Promise.all(paths.map(async path => {
    try { return [path, (await workspace.readFile(path, 1, 1)).digest]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null]; throw error; }
  }));
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { runId, executionIdentity: 'native:' + workspace.root, patchId: digest, snapshotDigest: digest };
}

export async function withNativeTaskAcceptance<T>(workspace: Workspace, ledger: TaskAcceptanceLedger, runId: string,
  work: () => Promise<T>, previousEvidence?: unknown, journal: Parameters<typeof withTaskAcceptanceDelivery>[4] = []): Promise<T> {
  return withTaskAcceptanceDelivery(workspace.root, ledger, () => scopes.run({ workspace, ledger, runId }, async () => {
    const binding = await nativeTaskSnapshot(workspace, ledger, runId);
    confirmTaskAcceptanceImport(binding, async () => (await nativeTaskSnapshot(workspace, ledger, runId)).snapshotDigest === binding.snapshotDigest);
    return work();
  }), previousEvidence, journal);
}

/** Wrap the final executable set, including per-invocation tools. Unknown tools fail closed. */
export function nativeTaskTools(tools: ToolSet): ToolSet {
  const scope = scopes.getStore();
  if (!scope) return tools;
  return Object.fromEntries(Object.entries(tools).filter(([name]) => readTools.has(name) || editTools.has(name) || name === 'run_check').map(([name, tool]) => {
    if (!('execute' in tool)) throw new Error('TASK_ACCEPTANCE_NATIVE_TOOL_UNSUPPORTED');
    return [name, { ...tool, approvalVersion: (tool.approvalVersion ?? '') + ':native-task-v1', execute: async (input: any, context: any) => {
      if (readTools.has(name)) return tool.execute(input, context);
      const contract = scope.ledger.revisions.at(-1)!.contract;
      if (editTools.has(name)) {
        const paths: unknown[] = name === 'apply_reviewed_replacement' ? [input?.path] :
          Array.isArray(input?.changes) ? input.changes.map((change: any) => change?.path) : [];
        if (!paths.length || paths.some(path => typeof path !== 'string' || !contract.allowedWritePaths.includes(path))) {
          throw new Error('TASK_ACCEPTANCE_SCOPE_VIOLATION: no edit was applied; use only the exact task write paths.');
        }
        const result = await tool.execute(input, context);
        const binding = await nativeTaskSnapshot(scope.workspace, scope.ledger, scope.runId);
        confirmTaskAcceptanceImport(binding, async () => (await nativeTaskSnapshot(scope.workspace, scope.ledger, scope.runId)).snapshotDigest === binding.snapshotDigest);
        return result;
      }
      if (name !== 'run_check') throw new Error('TASK_ACCEPTANCE_NATIVE_TOOL_UNSUPPORTED: this bounded native task permits workspace reads, reviewed edits and its declared package checks only.');
      const checks = contract.requiredChecks.filter(check => check.kind === 'package-script' && check.script === input?.check && check.expectedScript === input?.expectedScript);
      if (!checks.length) throw new Error('TASK_ACCEPTANCE_CHECK_UNDECLARED: no command was executed.');
      const collector = taskAcceptanceChecks()!;
      collector.begin(checks.map(check => check.id));
      const before = await nativeTaskSnapshot(scope.workspace, scope.ledger, scope.runId);
      const startedAt = Date.now();
      const result: any = await tool.execute(input, context);
      const after = await nativeTaskSnapshot(scope.workspace, scope.ledger, scope.runId);
      if (Array.isArray(result?.command) && Number.isInteger(result.exitCode) && typeof result.timedOut === 'boolean') {
        for (const check of checks) if (JSON.stringify(result.command) === JSON.stringify([check.command, ...check.args])) {
          collector.record(check.id, before, after, result, context?.toolCall?.id ? { id: context.toolCall.id, name, startedAt } : undefined);
        }
      }
      confirmTaskAcceptanceImport(after, async () => (await nativeTaskSnapshot(scope.workspace, scope.ledger, scope.runId)).snapshotDigest === after.snapshotDigest);
      return result;
    } }];
  }));
}
