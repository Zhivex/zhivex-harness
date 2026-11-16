import type {ApplicationClient} from '../application/client.js';
import type {HarnessClientData} from '../client/protocol.js';
import type {CliOptions} from './arguments.js';
import {HarnessConfigError, HarnessStateConflictError} from '../runtime/errors.js';
import {randomUUID} from 'node:crypto';

/** Uses host-owned stores and revision checks; never opens project files in the CLI. */
export async function serviceCheckpointDocument(client: ApplicationClient, options: CliOptions) {
  const [target = '', second, ...paths] = options.checkpointArguments ?? [];
  const sessionId = ['list', 'capture'].includes(options.checkpointsCommand!) ? target : options.sessionId!;
  const call = async (command: Record<string, unknown>): Promise<HarnessClientData> => {
    if (!client.capabilities.includes(String(command.method))) throw new HarnessConfigError('The host does not support this checkpoint operation. Update the host before retrying.');
    const response = await client.command(command);
    if (!response.ok) throw new HarnessStateConflictError(`Checkpoint command failed: ${response.error.code}. Inspect the saved operation before retrying.`);
    return response.data;
  };
  if (options.checkpointsCommand === 'storage') return call({method: 'checkpoint.storage'});
  if (options.checkpointsCommand === 'prune-review' || options.checkpointsCommand === 'prune-apply') {
    const applying = options.checkpointsCommand === 'prune-apply';
    const selected = (options.checkpointArguments ?? []).slice(applying ? 1 : 0);
    const selection = {checkpointIds: [] as string[], completedRestoreIds: [] as string[]};
    for (const item of selected) {
      const match = /^(checkpoint|restore):([0-9a-f-]+)$/i.exec(item);
      if (!match) throw new HarnessConfigError('Select exact IDs as checkpoint:<id> or restore:<id>.');
      (match[1]!.toLowerCase() === 'checkpoint' ? selection.checkpointIds : selection.completedRestoreIds).push(match[2]!);
    }
    return call({method: applying ? 'checkpoint.pruneApply' : 'checkpoint.pruneReview', selection,
      ...(applying ? {reviewedPlanId: target, idempotencyKey: `retention_cli_${randomUUID()}`} : {})});
  }
  const source = await call({method: 'session.get', sessionId});
  if (source.kind !== 'session') throw new HarnessStateConflictError('Unexpected checkpoint session response.');
  const mutation = () => ({sessionId, expectedRevision: source.session.revision, idempotencyKey: `checkpoint_cli_${randomUUID()}`});
  const inspect = async (checkpointId: string) => {
    const result = await call({method: 'checkpoint.inspect', sessionId, checkpointId});
    if (result.kind !== 'checkpoint') throw new HarnessStateConflictError('Unexpected checkpoint inspection.');
    return result.inspection;
  };
  switch (options.checkpointsCommand) {
    case 'list': return call({method: 'checkpoint.list', sessionId});
    case 'capture': return call({method: 'checkpoint.capture', ...mutation(), turnId: second, paths});
    case 'inspect': return {kind: 'checkpoint', inspection: await inspect(target)};
    case 'prepare': {
      const inspection = await inspect(target);
      const expected: Record<string, string> = {};
      for (const file of inspection.files) {
        if (file.status !== 'available') throw new HarnessStateConflictError('Checkpoint contains unavailable files or mode conflicts; inspect before proceeding.');
        expected[file.path] = file.expectedDigest;
      }
      const result = await call({method: 'restore.prepare', ...mutation(), checkpointId: target, expected});
      if (result.kind !== 'restore') throw new HarnessStateConflictError('Unexpected restore response.');
      return {kind: 'restore-review', operationId: result.operation.id, stage: result.operation.stage,
        reviewedProposalId: result.operation.proposalId, previewStatus: result.preview.status,
        ...(result.preview.status === 'available' ? {diff: result.preview.diff} : {}), coverage: inspection.coverage};
    }
    case 'review': {
      const result = await call({method: 'restore.get', sessionId, operationId: target});
      if (result.kind !== 'restore') throw new HarnessStateConflictError('Unexpected restore response.');
      return {kind: 'restore-review', operationId: result.operation.id, stage: result.operation.stage,
        reviewedProposalId: result.operation.proposalId, forkSessionId: result.operation.forkSessionId,
        previewStatus: result.preview.status, ...(result.preview.status === 'available' ? {diff: result.preview.diff} : {}),
        coverage: (await inspect(result.operation.checkpointId)).coverage};
    }
    case 'apply': {
      // Keep the operator-supplied proposal: never replace it with a freshly read digest.
      const result = await call({method: 'restore.apply', ...mutation(), operationId: target, reviewedProposalId: second});
      if (result.kind !== 'restore' || !result.session) throw new HarnessStateConflictError('Restore result unavailable; inspect the operation before retrying.');
      return {kind: 'restore-completed', operationId: result.operation.id, stage: result.operation.stage, session: result.session};
    }
    case 'recover': {
      const result = await call({method: 'restore.recoverFork', ...mutation(), operationId: target, forkSessionId: second});
      if (result.kind !== 'restore') throw new HarnessStateConflictError('Unexpected restore recovery response.');
      return {kind: 'restore-recovery', operationId: result.operation.id, stage: result.operation.stage, forkSessionId: result.operation.forkSessionId};
    }
    default: throw new HarnessConfigError('This checkpoint operation does not yet support service mode.');
  }
}
