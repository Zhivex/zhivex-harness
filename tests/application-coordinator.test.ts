import {test, expect} from 'bun:test';
import {mkdtemp, rm, readFile, open} from 'node:fs/promises';
import path from 'node:path';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {acquireApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {connectApplication} from '../packages/core/src/application/client.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {requestLocalServiceDocument} from '../packages/core/src/client/local-transport.js';

test('concurrent launchers discover one coordinator, share runtime state, and attached close preserves ownership', async () => {
  const root = await mkdtemp('/tmp/zhx-coordinator-');
  let stored: string | null = null, reads = 0;
  const options = {secrets: {async read() {reads++; return stored;}, async write(value: string) {stored = value;}}, validateProvider: async () => {},
    startHost: async (input: Parameters<typeof startAssistantHost>[0]) => startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel({streamEvents: [[{type: 'text-delta', textDelta: 'Shared host'}, {type: 'finish', finishReason: 'stop'}]]})}})};
  const [first, second] = await Promise.all([acquireApplicationCoordinator(root, options), acquireApplicationCoordinator(root, options)]);
  const owner = first.ownsService ? first : second, attached = first.ownsService ? second : first;
  try {
    expect([first.ownsService, second.ownsService].filter(Boolean)).toHaveLength(1);
    expect(reads).toBe(1);
    await first.client.call('action', {name: 'begin', value: {}});
    await second.client.call('action', {name: 'provider', value: {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture-key'}});
    await first.client.call('action', {name: 'start', value: {}});
    const a = await first.client.state(), b = await second.client.state();
    expect(a.credentialsPath).toBe(b.credentialsPath); expect(a.state.ready).toBe(true);
    const cli = await connectApplication(a.credentialsPath!), desktop = await connectApplication(b.credentialsPath!);
    const session = await cli.command({method: 'session.create', idempotencyKey: 'shared', title: 'From CLI'});
    expect(session.ok).toBe(true);
    expect(await desktop.command({method: 'session.list'})).toMatchObject({ok: true, data: {sessions: [{title: 'From CLI'}]}});
    await attached.close();
    expect((await (await connectCoordinator(root)).state()).state.ready).toBe(true);
    const file = path.join(root, 'coordinator.json');
    const handle = await open(file, 'r');
    let credentials;
    try {
      expect((await handle.stat()).mode & 0o777).toBe(0o600);
      credentials = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    expect(await requestLocalServiceDocument(credentials, 'application', {version: 2, method: 'state'})).toMatchObject({ok: false, error: 'COORDINATOR_VERSION_UNSUPPORTED', detail:{schemaVersion:1, recovery:'upgrade'}});
    await expect(requestLocalServiceDocument({...credentials, token: '0'.repeat(64)}, 'application', {version: 1, method: 'state'})).rejects.toThrow('LOCAL_SERVICE_HTTP_403');
    await expect(first.client.call('arbitrary' as never)).rejects.toThrow('COORDINATOR_REQUEST_FAILED');
    expect(JSON.stringify(await first.client.state())).not.toContain('fixture-key');
    await owner.close();
    await expect(connectCoordinator(root)).rejects.toThrow();
    const restarted = await acquireApplicationCoordinator(root, options);
    try {expect(restarted.ownsService).toBe(true); expect((await restarted.client.state()).state.ready).toBe(true);} finally {await restarted.close();}
  } finally {await owner.close(); await rm(root, {recursive: true, force: true});}
});

test('a second launcher waits for a live owner whose credential read exceeds the former three-second admission window', async () => {
  const root = await mkdtemp('/tmp/zhx-slow-owner-');
  let entered!: () => void, release!: () => void, reads = 0;
  const reading = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const options = {secrets: {async read() {reads++; entered(); await gate; return null;}, async write() {}}};
  const first = acquireApplicationCoordinator(root, options);
  await reading;
  const second = acquireApplicationCoordinator(root, options);
  // Attach handlers before holding the owner's publication barrier.
  const joined = Promise.all([first, second]); void joined.catch(() => {});
  const timer = setTimeout(release, 3500);
  try {
    const [owner, attached] = await joined;
    try {
      expect(owner.ownsService).toBe(true); expect(attached.ownsService).toBe(false);
      expect(reads).toBe(1);
      expect((await attached.client.state()).state.locked).toBe(false);
      await attached.close(); expect((await owner.client.state()).state.locked).toBe(false);
    } finally {await attached.close(); await owner.close();}
  } finally {
    clearTimeout(timer); release();
    const settled = await Promise.allSettled([first, second]);
    for (const result of settled) if (result.status === 'fulfilled') await result.value.close();
    await rm(root, {recursive: true, force: true});
  }
}, 10000);
