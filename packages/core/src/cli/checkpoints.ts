import { resolveHarnessConfig } from '../runtime/config.js';
import { openHarnessPersistence } from '../persistence/operations.js';
import { openCliSessionStore, type CliSession } from '../persistence/sessions.js';
import { openWorkspaceCheckpointStore } from '../persistence/workspace-checkpoints.js';
import { Workspace } from '../workspace/workspace.js';
import { fileDigestSchema } from '../workspace/edit-contracts.js';
import { sanitizeTerminalText } from './terminal/terminal-ui.js';
import { CliUsageError, type CliOptions } from './arguments.js';

/** Operator CLI over the existing checkpoint API; never constructs a model. */
export async function checkpointCliDocument(options: CliOptions) {
  const config = resolveHarnessConfig(options);
  const workspace = await Workspace.open(config.workspace);
  const sessions = await openCliSessionStore({ workspace: workspace.root, stateDirectory: config.stateDirectory, scope: config.scope });
  let store: Awaited<ReturnType<typeof openWorkspaceCheckpointStore>> | undefined;
  const [target = '', second, ...paths] = options.checkpointArguments ?? [];
  if (!target && options.checkpointsCommand !== 'storage') { sessions.close(); throw new CliUsageError('Checkpoint target is required.'); }
  const assertTerminal = async (sessionId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) throw new Error('Checkpoint conversation was not found.');
    const persistence = await openHarnessPersistence(config);
    try {
      for (const run of session.runs) {
        const state = await persistence.store.load(run.runId, config.scope);
        if (!state || !['completed', 'failed', 'cancelled', 'timed_out'].includes(state.status)) {
          throw new Error('Checkpoint operation requires all conversation runs to be terminal.');
        }
      }
    } finally { persistence.close(); }
    return session;
  };
  try {
    store = await openWorkspaceCheckpointStore(workspace, sessions);
    switch (options.checkpointsCommand) {
      case 'storage': return { kind: 'checkpoint-storage', ...store.storageStatus() };
      case 'prune-review':
      case 'prune-apply': {
        const applying = options.checkpointsCommand === 'prune-apply';
        const selected = (options.checkpointArguments ?? []).slice(applying ? 1 : 0);
        const selection = { checkpointIds: [] as string[], completedRestoreIds: [] as string[] };
        for (const item of selected) {
          const match = /^(checkpoint|restore):([0-9a-f-]+)$/i.exec(item);
          if (!match) throw new CliUsageError('Select exact IDs as checkpoint:<id> or restore:<id>.');
          (match[1]!.toLowerCase() === 'checkpoint' ? selection.checkpointIds : selection.completedRestoreIds).push(match[2]!);
        }
        const plan = applying ? await store.applyRetention(selection, fileDigestSchema.parse(target)) : store.prepareRetention(selection);
        return { kind: applying ? 'checkpoint-pruned' : 'checkpoint-prune-review', ...plan };
      }
      case 'list': return { kind: 'checkpoints', checkpoints: store.listCheckpoints(target), restores: store.listRestores(target) };
      case 'capture': {
        await assertTerminal(target);
        const checkpoint = await store.capture({ sessionId: target, turnId: second!, paths });
        return { kind: 'checkpoint', inspection: await store.inspectCheckpoint(checkpoint.id) };
      }
      case 'inspect': return { kind: 'checkpoint', inspection: await store.inspectCheckpoint(target) };
      case 'prepare': {
        const inspection = await store.inspectCheckpoint(target);
        await assertTerminal(inspection.checkpoint.sessionId);
        const expected: Record<string, string> = {};
        for (const file of inspection.files) {
          if (file.status !== 'available') throw new Error('Checkpoint contains unavailable files or mode conflicts; inspect it before proceeding.');
          expected[file.path] = file.expectedDigest;
        }
        const { operation } = await store.prepareRestore(target, expected);
        return { kind: 'restore-review', operationId: operation.id, stage: operation.stage,
          reviewedProposalId: operation.proposalId, diff: await store.previewRestore(operation.id), coverage: inspection.coverage };
      }
      case 'review': {
        const operation = store.getOperation(target);
        let diff: Awaited<ReturnType<typeof store.previewRestore>> | undefined;
        try { diff = await store.previewRestore(target); } catch { /* A conflict must not conceal a durable operation. */ }
        return { kind: 'restore-review', operationId: operation.id, stage: operation.stage,
          reviewedProposalId: operation.proposalId, forkSessionId: operation.forkSessionId,
          previewStatus: diff ? 'available' : 'unavailable', ...(diff ? { diff } : {}),
          coverage: (await store.inspectCheckpoint(operation.checkpoint.id)).coverage };
      }
      case 'recover': {
        const operation = store.getOperation(target);
        await assertTerminal(operation.checkpoint.sessionId);
        const recovered = await store.recoverFork(target, second!);
        return { kind: 'restore-recovery', operationId: recovered.id, stage: recovered.stage, forkSessionId: recovered.forkSessionId };
      }
      case 'apply': {
        const operation = store.getOperation(target);
        await assertTerminal(operation.checkpoint.sessionId);
        const completed = await store.applyRestore(target, fileDigestSchema.parse(second));
        const session = await sessions.get(completed.forkSessionId!);
        if (!session) throw new Error('Restore derivative is unavailable; inspect the operation before retrying.');
        return { kind: 'restore-completed', operationId: completed.id, stage: completed.stage, session };
      }
      default: throw new CliUsageError('Unknown checkpoint command.');
    }
  } finally { store?.close(); sessions.close(); }
}

export async function manageCheckpoints(options: CliOptions): Promise<CliSession | undefined> {
  const document = await checkpointCliDocument(options);
  const encoded = JSON.stringify({ schemaVersion: 1, ...document }, null, 2);
  process.stdout.write((options.json ? encoded : sanitizeTerminalText(encoded)) + '\n');
  if (document.kind === 'restore-completed' && document.session) {
    if (!options.json) process.stdout.write(`Continue in the restored conversation: zhx --session ${document.session.sessionId}\n`);
    return document.session;
  }
}
