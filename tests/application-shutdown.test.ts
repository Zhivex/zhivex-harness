import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { GENERAL_ASSISTANT_PROFILE } from '../packages/core/src/engine/index.js';
import { startManagedAssistant } from '../packages/core/src/application/assistant/managed/setup.js';
import { startAssistantHost } from '../packages/core/src/application/assistant/host.js';
import { connectApplication } from '../packages/core/src/application/client.js';

test('quit inspection preserves pending approval and admission; confirmed shutdown persists the review without applying it', async () => {
  const directory = await mkdtemp('/tmp/zhx-quit-');
  let stored: string | null = null, workspace = '';
  const options = {secrets: {async read() {return stored;}, async write(value: string) {stored = value;}}, validateProvider: async () => {},
    startHost: async (input: Parameters<typeof startAssistantHost>[0]) => {
      workspace = input.directory + '/workspace'; await mkdir(workspace, {recursive: true, mode: 0o700}); await writeFile(workspace + '/note.txt', 'before');
      return startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel({streamEvents: [[{type: 'tool-call', toolCall: {id: 'edit', name: 'apply_reviewed_replacement', input: {path: 'note.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before').digest('hex'), oldText: 'before', newText: 'after'}}}, {type: 'finish', finishReason: 'tool-calls'}]]}), agentProfile: {...GENERAL_ASSISTANT_PROFILE, toolNames: ['apply_reviewed_replacement']}}});
    }};
  let manager = await startManagedAssistant(directory, options);
  try {
    expect(await manager.shutdownSummary()).toEqual({runtimes: [], backgroundServices: false});
    await manager.action('begin', {});
    await manager.action('provider', {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture-key'});
    await manager.action('start', {});
    let client = await connectApplication(manager.currentHost()!.credentialsPath);
    const created = await client.command({method: 'session.create', idempotencyKey: 'create'});
    if (!created.ok || created.data.kind !== 'session') throw new Error('SESSION_FAILED');
    const session = created.data.session;
    const started = await client.command({method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Edit note'});
    if (!started.ok || started.data.kind !== 'run') throw new Error('RUN_FAILED');
    expect(started.data.run.status).toBe('waiting_approval');
    expect(await manager.shutdownSummary()).toMatchObject({runtimes: [{area: 'assistant', available: true, activeRuns: 1, pendingReviews: 1}]});
    expect((await client.command({method: 'session.create', idempotencyKey: 'after-inspection'})).ok).toBe(true);
    expect(await manager.shutdownSummary()).toMatchObject({runtimes: [{activeRuns: 1, pendingReviews: 1}]});
    expect(await readFile(workspace + '/note.txt', 'utf8')).toBe('before');
    await manager.close(); manager = await startManagedAssistant(directory, options);
    client = await connectApplication(manager.currentHost()!.credentialsPath);
    const result = await client.command({method: 'run.get', sessionId: session.sessionId, runId: started.data.run.runId});
    expect(result).toMatchObject({ok: true, data: {run: {status: 'waiting_approval'}}});
    expect(await manager.shutdownSummary()).toMatchObject({runtimes: [{activeRuns: 1, pendingReviews: 1}]});
  } finally {await manager.close(); await rm(directory, {recursive: true, force: true});}
});
