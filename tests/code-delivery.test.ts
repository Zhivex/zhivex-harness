import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startCodeHost } from '../packages/core/src/application/code/host.js';
import { connectApplication } from '../packages/core/src/application/client.js';
import type { CommitReview, CommitOperation } from '../packages/core/src/application/code/git-delivery.js';

test('Code delivery refuses pending runs, resumes admission and reconciles one reviewed commit after restart', async () => {
  const root = await mkdtemp('/tmp/code-git-host-');
  const git = (args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {encoding: 'utf8'}).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(root + '/a.txt', 'before\n'); git(['add', 'a.txt']); git(['commit', '-qm', 'initial']);
  const model = createMockLanguageModel({streamEvents: [[{type: 'tool-call', toolCall: {id: 'edit', name: 'apply_reviewed_replacement', input: {path: 'a.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before\n').digest('hex'), oldText: 'before', newText: 'after'}}}, {type: 'finish', finishReason: 'tool-calls'}]]});
  const options = {workspace: root, directory: root + '/socket', engine: {modelInstance: model, subagentProfiles: []}};
  let host = await startCodeHost(options);
  try {
    const client = await connectApplication(host.credentialsPath);
    const created = await client.command({method: 'session.create', idempotencyKey: 'create'});
    if (!created.ok || created.data.kind !== 'session') throw new Error('SESSION_FAILED');
    const session = created.data.session;
    const run = await client.command({method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'edit', prompt: 'Edit a.txt'});
    if (!run.ok || run.data.kind !== 'run') throw new Error('RUN_FAILED');
    expect(run.data.run.status).toBe('waiting_approval');
    await expect(host.delivery('stage', ['a.txt'])).rejects.toThrow('GIT_RUNTIME_BUSY');
    const second = await client.command({method: 'session.create', idempotencyKey: 'admission-resumed'}); expect(second.ok).toBe(true);
    expect((await client.command({method: 'run.cancel', sessionId: session.sessionId, runId: run.data.run.runId, expectedRevision: run.data.run.revision, idempotencyKey: 'cancel'})).ok).toBe(true);
    await writeFile(root + '/a.txt', 'reviewed\n');
    const head = git(['rev-parse', 'HEAD']);
    await host.delivery('stage', ['a.txt']);
    const review = await host.delivery('review-commit', {paths: ['a.txt'], message: 'Reviewed'}) as CommitReview;
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    const committed = await host.delivery('commit', review.ticketId) as CommitOperation;
    expect(committed.status).toBe('completed');
    expect((await host.delivery('commit', review.ticketId) as CommitOperation).commit).toBe(committed.commit);
    expect(git(['rev-list', '--count', 'HEAD'])).toBe('2');
    await host.close(); host = await startCodeHost(options);
    expect(await host.delivery('reconcile-commit', review.ticketId)).toMatchObject({status: 'completed', commit: committed.commit});
    await expect(host.delivery('arbitrary-command', 'rm -rf /')).rejects.toThrow('GIT_ACTION_INVALID');
  } finally {await host.close(); await rm(root, {recursive: true, force: true});}
});
