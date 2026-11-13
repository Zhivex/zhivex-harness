import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startAssistantHost } from '../src/host.js';
import { startAssistantWeb } from '../src/web/server.js';

test('local web authenticates, rejects cross-origin mutations and persists conversations across token rotation', async () => {
  const directory = await mkdtemp('/tmp/assistant-web-');
  const assets = directory + '/assets'; await mkdir(assets); await writeFile(assets + '/index.html', '<h1>Assistant</h1>');
  await writeFile(directory + '/private.txt', 'private'); await symlink(directory + '/private.txt', assets + '/escape.txt');
  let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  let web: Awaited<ReturnType<typeof startAssistantWeb>> | undefined;
  try {
    host = await startAssistantHost({ directory: directory + '/state', ownerId: 'owner', engine: { modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Hello' }, { type: 'finish', finishReason: 'stop' }]] }) } });
    web = await startAssistantWeb(host, { assetsDirectory: assets, timeZone: 'America/Argentina/Buenos_Aires' });
    const token = new URLSearchParams(new URL(web.url).hash.slice(1)).get('token')!;
    const headers = { authorization: `Bearer ${token}`, origin: web.origin, 'content-type': 'application/json' };
    expect((await fetch(web.origin + '/')).status).toBe(200);
    expect((await fetch(web.origin + '/escape.txt')).status).toBe(404);
    expect((await fetch(web.origin + '/api/state')).status).toBe(401);
    expect((await fetch(web.origin + '/api/state', { headers: { ...headers, host: 'evil.test' } })).status).toBe(403);
    expect((await fetch(web.origin + '/api/message', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
    expect((await fetch(web.origin + '/api/message', { method: 'POST', headers, body: JSON.stringify({ prompt: '', key: randomUUID() }) })).status).toBe(400);
    const body = JSON.stringify({ prompt: 'Hello from the web', key: randomUUID() });
    const sent = await fetch(web.origin + '/api/message', { method: 'POST', headers, body });
    const sentBody = await sent.json(); expect(sentBody).not.toHaveProperty('error'); expect(sent.status).toBe(200);
    await fetch(web.origin + '/api/message', { method: 'POST', headers, body });
    const state = await (await fetch(web.origin + '/api/state', { headers })).json() as any;
    expect(state.sessions).toHaveLength(1); expect(state.sessions[0].runs).toHaveLength(1);
    expect(state.sessions[0].runs[0].prompt).toBe('Hello from the web');
    expect(state.timeZone).toBe('America/Argentina/Buenos_Aires');
    expect((await fetch(web.origin + '/api/task-metrics')).status).toBe(401);
    const metrics = await (await fetch(web.origin + '/api/task-metrics', { headers })).json() as any;
    expect(metrics.tasks).toHaveLength(1);
    expect(metrics.tasks[0].outcome).toBe('unverified');
    expect(metrics.tasks[0].estimatedUsd).toBeNull();
    const feedback = { taskId: metrics.tasks[0].taskId, expectedRevision: metrics.tasks[0].revision, outcome: 'success', category: 'general' };
    expect((await fetch(web.origin + '/api/task-metrics/feedback', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: JSON.stringify(feedback) })).status).toBe(403);
    expect((await fetch(web.origin + '/api/task-metrics/feedback', { method: 'POST', headers, body: JSON.stringify({ ...feedback, expectedRevision: '0'.repeat(64) }) })).status).toBe(409);
    expect((await fetch(web.origin + '/api/task-metrics/feedback', { method: 'POST', headers, body: JSON.stringify(feedback) })).status).toBe(200);

    expect(await (await fetch(web.origin + '/api/agenda', { headers })).json()).toMatchObject({ connected: false });
    expect((await fetch(web.origin + '/api/automation', { method: 'POST', headers, body: JSON.stringify({ command: '/daily pause' }) })).status).toBe(409);
    await web.close(); web = undefined; await host.close(); host = undefined;
    host = await startAssistantHost({ directory: directory + '/state', ownerId: 'owner', engine: { modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Hello' }, { type: 'finish', finishReason: 'stop' }]] }) } });
    web = await startAssistantWeb(host, { assetsDirectory: assets });
    expect((await fetch(web.origin + '/api/state', { headers: { authorization: headers.authorization } })).status).toBe(401);
    const newToken = new URLSearchParams(new URL(web.url).hash.slice(1)).get('token');
    const restored = await (await fetch(web.origin + '/api/state', { headers: { authorization: `Bearer ${newToken}` } })).json() as any;
    expect(restored.sessions[0].runs[0].prompt).toBe('Hello from the web');
    expect(restored.sessions[0].sessionId).toBe(state.sessions[0].sessionId);
  } finally { await web?.close(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('web review revalidates exact actions and never repeats an approved effect', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile, stat } = await import('node:fs/promises');
  const { GENERAL_ASSISTANT_PROFILE } = await import('@zhivex-ai/harness/engine');
  const directory = await mkdtemp('/tmp/assistant-web-review-');
  await mkdir(directory + '/workspace', { mode: 0o700 }); await writeFile(directory + '/workspace/note.txt', 'before');
  await mkdir(directory + '/assets'); await writeFile(directory + '/assets/index.html', 'Assistant');
  const model = createMockLanguageModel({ streamEvents: [[{ type: 'tool-call', toolCall: { id: 'edit', name: 'apply_reviewed_replacement', input: {
    path: 'note.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before').digest('hex'), oldText: 'before', newText: 'after'
  } } }, { type: 'finish', finishReason: 'tool-calls' }], [{ type: 'text-delta', textDelta: 'Updated' }, { type: 'finish', finishReason: 'stop' }]] });
  const host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: model, agentProfile: { ...GENERAL_ASSISTANT_PROFILE, toolNames: ['apply_reviewed_replacement'] } } });
  let pages = 0;
  const web = await startAssistantWeb({ ...host, agendaSource: { binding: 'test', calendarId: 'primary', async list() { pages++; return { events: [], nextPageToken: 'loop', complete: false }; } } }, { assetsDirectory: directory + '/assets' });
  const headers = { authorization: 'Bearer ' + new URLSearchParams(new URL(web.url).hash.slice(1)).get('token'), origin: web.origin, 'content-type': 'application/json' };
  const post = (route: string, body: unknown) => fetch(web.origin + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    expect((await post('message', { prompt: 'Update note', key: randomUUID() })).status).toBe(200);
    const state = await (await fetch(web.origin + '/api/state', { headers })).json() as any;
    const session = state.sessions[0], run = session.runs[0]; expect(run.review.canDecide).toBe(true);
    const pendingMetrics = await host.taskMetrics.report();
    expect(pendingMetrics.tasks).toHaveLength(1);
    expect(pendingMetrics.tasks[0]).toMatchObject({ endedAt: null, durationMs: null, outcome: 'unverified' });

    const decision = { sessionId: session.sessionId, runId: run.runId, digest: run.review.digest, approve: true, key: randomUUID() };
    expect((await post('decision', { ...decision, digest: '0'.repeat(64) })).status).toBe(409);
    expect(await readFile(directory + '/workspace/note.txt', 'utf8')).toBe('before');
    expect((await post('decision', decision)).status).toBe(200);
    expect(await readFile(directory + '/workspace/note.txt', 'utf8')).toBe('after');
    const completedMetrics = await host.taskMetrics.report();
    expect(completedMetrics.tasks).toHaveLength(1);
    expect(completedMetrics.tasks[0]?.runCount).toBe(1);
    expect(completedMetrics.tasks[0]?.durationMs).not.toBeNull();

    const modified = (await stat(directory + '/workspace/note.txt')).mtimeMs;
    expect((await post('decision', decision)).status).toBe(409);
    expect((await stat(directory + '/workspace/note.txt')).mtimeMs).toBe(modified);
    expect(await (await fetch(web.origin + '/api/agenda', { headers })).json()).toEqual({ error: 'AGENDA_INCOMPLETE' });
    expect(pages).toBe(10);
  } finally { await web.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
