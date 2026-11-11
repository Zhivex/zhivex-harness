import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startManagedAssistant } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';
import { googleScopes } from '../src/integrations/google.js';

test('new-agent daily selection persists, old agents retain their catalog and setup never reveals credentials', async () => {
  const directory = await mkdtemp('/tmp/daily-setup-'); await mkdir(directory + '/assets'); await writeFile(directory + '/assets/index.html', 'Assistant');
  let stored: string | null = null;
  const options = { assetsDirectory: directory + '/assets', secrets: { async read() { return stored; }, async write(text: string) { stored = text; } }, validateProvider: async () => {},
    startHost: (input: Parameters<typeof startAssistantHost>[0]) => startAssistantHost({ ...input, engine: { ...input.engine, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Ready' }, { type: 'finish', finishReason: 'stop' }]] }) } }) };
  let app = await startManagedAssistant(directory + '/runtime', options);
  const request = async (route: string, body?: unknown) => {
    const headers = { authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('token')}`, origin: app.origin, 'content-type': 'application/json' };
    return fetch(`${app.origin}/api/${route}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  };
  try {
    await request('setup/begin', {});
    await request('setup/provider', { baseURL: 'https://example.test/v1', apiKey: 'private-model-key', apiMode: 'chat', model: 'test' });
    expect((await request('setup/tools', { daily: true, web: { apiKeyEnv: 'MISSING_BRAVE_TEST_KEY' } })).status).toBe(400);
    const state = await (await request('setup/tools', { daily: true })).json() as any;
    expect(state.tools.daily).toBe(true); expect(JSON.stringify(state)).not.toContain('private-model-key');
    expect((await request('setup/start', {})).status).toBe(200);
    expect(await (await request('daily')).json()).toMatchObject({ enabled: true, total: 0 });
    expect((await request('setup/tools', { daily: false })).status).toBe(400);
    await app.close(); app = await startManagedAssistant(directory + '/runtime', options);
    expect(await (await request('daily')).json()).toMatchObject({ enabled: true });
    const first = await (await request('setup')).json() as any, firstId = first.profiles[0].id;
    await request('setup/begin', {}); await request('setup/reuse-provider', { id: first.connections[0].id }); await request('setup/start', {});
    expect(await (await request('daily')).json()).toMatchObject({ enabled: false });
    expect((await request('setup/select', { id: firstId })).status).toBe(200);
    expect(await (await request('daily')).json()).toMatchObject({ enabled: true });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('managed Google tool consent is separate from Calendar and state hides OAuth credentials', async () => {
  const directory = await mkdtemp('/tmp/google-setup-'); await mkdir(directory + '/assets'); await writeFile(directory + '/assets/index.html', 'Assistant');
  let stored: string | null = null;
  const integrationFetch = Object.assign(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/token')) return Response.json({ token_type: 'Bearer', access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: googleScopes({ mail: true, drive: true }).join(' ') });
    if (url.endsWith('/userinfo')) return Response.json({ sub: 'account1', email: 'owner@example.com', email_verified: true });
    throw new Error('UNEXPECTED_NETWORK');
  }, { preconnect: fetch.preconnect });
  const app = await startManagedAssistant(directory + '/runtime', { assetsDirectory: directory + '/assets', integrationFetch, secrets: { async read() { return stored; }, async write(text) { stored = text; } } });
  const headers = { authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('token')}`, origin: app.origin, 'content-type': 'application/json' };
  const post = (action: string, body: unknown) => fetch(app.origin + '/api/setup/' + action, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    await post('begin', {});
    const result = await (await post('google', { clientId: 'test.apps.googleusercontent.com', mail: true, drive: true })).json() as any;
    const auth = new URL(result.authorizationUrl); expect(auth.searchParams.get('scope')).toContain('gmail.compose'); expect(auth.searchParams.get('scope')).not.toContain('calendar.events');
    expect((await post('start', {})).status).toBe(400);
    const callback = new URL(auth.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'code'); callback.searchParams.set('state', auth.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    let state: any;
    for (let i = 0; i < 50; i++) { state = await (await fetch(app.origin + '/api/setup', { headers })).json(); if (!state.calendar.pending) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(state.google).toMatchObject({ connected: true, mail: true, drive: true, email: 'owner@example.com' });
    expect(state.calendar.connected).toBe(false);
    expect(JSON.stringify(state)).not.toContain('private-access'); expect(JSON.stringify(state)).not.toContain('encryptionKey');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
