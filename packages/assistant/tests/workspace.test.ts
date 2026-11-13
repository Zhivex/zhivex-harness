import { test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startAssistantHost } from '../src/host.js';
import { startAssistantWeb } from '../src/web/server.js';
import { nativeProjectSelection } from '../src/native-selection.js';
import { applyActivityPage, emptyActivity } from '../web/src/workspace-activity.js';
import type { HarnessActivityPage } from '../src/application-contracts.js';

test('native selection requires a correlated private-parent response and handles cancellation', async () => {
  const input = new PassThrough(), output = new PassThrough(); let stopped = false, request = '';
  output.on('data', data => { request = String(data); });
  const bridge = nativeProjectSelection(input, output, () => { stopped = true; });
  const selecting = bridge.choose(); const id = JSON.parse(request).requestId;
  await expect(bridge.choose()).rejects.toThrow('NATIVE_SELECTION_BUSY');
  input.write(JSON.stringify({ kind: 'project-selected', requestId: randomUUID(), path: '/wrong' }) + '\n');
  input.write(JSON.stringify({ kind: 'project-selected', requestId: id, path: '/selected/repository' }) + '\n');
  expect(await selecting).toBe('/selected/repository');
  const cancelled = bridge.choose();
  input.write(JSON.stringify({ kind: 'project-selected', requestId: JSON.parse(request).requestId, path: null }) + '\n');
  expect(await cancelled).toBe(null);
  input.write('stop\n'); expect(stopped).toBe(true);
  input.end(); output.end();
});

test('workspace activity deduplicates replay, restores expired cursors and records tool failures', () => {
  const page: HarnessActivityPage = { schemaVersion: 1, nextCursor: 2, cursorExpired: false, events: [
    { schemaVersion: 1, eventId: 'one', sequence: 1, sessionId: 's', runId: 'r', at: 1, activity: { textDelta: 'hello ' } },
    { schemaVersion: 1, eventId: 'two', sequence: 2, sessionId: 's', runId: 'r', at: 2, activity: { type: 'tool-result', toolCallId: 'check', toolName: 'run_check', exitCode: 1 } },
  ] };
  const current = applyActivityPage(emptyActivity(), page);
  expect(applyActivityPage(current, page)).toEqual(current);
  expect(current.runs.r?.tools?.['tool:check']?.status).toBe('failed');
  const restored = applyActivityPage(current, { schemaVersion: 1, cursorExpired: true, nextCursor: 40, events: [], snapshot: { schemaVersion: 1, sequence: 40, sessionId: 's', runs: { r: { text: 'snapshot', status: 'completed', truncated: true } } } });
  expect(restored.runs.r?.text).toBe('snapshot'); expect(restored.recovered).toBe(true);
  expect(applyActivityPage(restored, page)).toEqual(restored);
});

test('workspace HTTP authenticates native selection, scopes file reads and validates attached bytes', async () => {
  const root = await mkdtemp('/tmp/as-ws-api-');
  let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined, web: Awaited<ReturnType<typeof startAssistantWeb>> | undefined;
  try {
    const repo = root + '/repo'; await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
    await mkdir(root + '/assets'); await writeFile(root + '/assets/index.html', 'Assistant');
    await writeFile(repo + '/note.txt', 'selected text'); await writeFile(root + '/outside.txt', 'outside secret'); await symlink(root + '/outside.txt', repo + '/link.txt');
    const model = createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'fixture-private-key Done. ' }, { type: 'finish', finishReason: 'stop' }]] });
    let received = ''; const stream = model.stream!; model.stream = input => { received = JSON.stringify(input.messages); return stream(input); };
    host = await startAssistantHost({ directory: root + '/host', ownerId: 'owner', engine: { modelInstance: model }, coding: { execution: 'local', configurationId: 'workspace-test', sensitiveValues: ['fixture-private-key'] } });
    let selections = 0;
    web = await startAssistantWeb(host, { assetsDirectory: root + '/assets', chooseProject: async () => { selections++; return repo; } });
    const headers = { authorization: `Bearer ${new URLSearchParams(new URL(web.url).hash.slice(1)).get('token')}`, origin: web.origin, 'content-type': 'application/json' };
    const request = (route: string, body?: unknown, custom = headers) => fetch(web!.origin + '/api/workspace/' + route, { method: body === undefined ? 'GET' : 'POST', headers: custom, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await fetch(web.origin + '/api/workspace/index')).status).toBe(401);
    expect((await request('select', {}, { ...headers, origin: 'https://evil.test' })).status).toBe(403);
    expect((await request('select', { path: '/arbitrary' })).status).toBe(400); expect(selections).toBe(0);
    const selected = await (await request('select', {})).json() as any;
    expect(selected.project.name).toBe('repo'); expect(selections).toBe(1);
    const projectKey = selected.project.projectKey;
    const files = await (await request(`files?projectKey=${projectKey}`)).json() as any;
    expect(files.files.some((file: any) => file.path === 'note.txt')).toBe(true);
    for (const path of ['../outside.txt', 'link.txt', '.zhivex-harness/assistant-owner.json']) expect((await request(`file?${new URLSearchParams({ projectKey, path })}`)).status).toBe(400);
    const file = await (await request(`file?${new URLSearchParams({ projectKey, path: 'note.txt' })}`)).json() as any;
    const conversation = await (await request('create', { projectKey, key: randomUUID(), title: 'Test' })).json() as any;
    const attachment = { path: file.path, digest: file.digest, startLine: file.startLine, endLine: file.endLine };
    await writeFile(repo + '/note.txt', 'changed');
    expect(await (await request('message', { conversationId: conversation.conversationId, prompt: 'Read', key: randomUUID(), attachments: [attachment] })).json()).toMatchObject({ error: 'FILE_CHANGED' });
    await writeFile(repo + '/note.txt', 'selected text');
    expect((await request('message', { conversationId: conversation.conversationId, prompt: 'Read attached file', key: randomUUID(), attachments: [attachment] })).status).toBe(200);
    expect(received).toContain('selected text');
    const snapshot = await (await request(`snapshot?conversationId=${encodeURIComponent(conversation.conversationId)}`)).json() as any;
    expect(JSON.stringify(snapshot)).not.toContain('fixture-private-key'); expect(snapshot.runs[0].cliResult).toBeUndefined(); expect(snapshot.runs[0].approvals).toEqual([]);
    const events = await (await request(`events?conversationId=${encodeURIComponent(conversation.conversationId)}&after=0`)).json() as any;
    expect(events.page.events.length).toBeGreaterThan(0); expect(JSON.stringify(events)).not.toContain('fixture-private-key');
    const other = await (await request('create', { projectKey, key: randomUUID() })).json() as any;
    expect((await request(`outputs?conversationId=${encodeURIComponent(other.conversationId)}&runId=${snapshot.runs[0].runId}`)).status).toBe(400);
    // Outstanding long polls release promptly on web shutdown.
    const waiting = request(`events?conversationId=${encodeURIComponent(conversation.conversationId)}&after=${events.page.nextCursor}`);
    await new Promise(resolve => setTimeout(resolve, 50)); const before = Date.now();
    await web.close(); web = undefined; await waiting.catch(() => undefined);
    expect(Date.now() - before).toBeLessThan(1500);
  } finally { await web?.close(); await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);
