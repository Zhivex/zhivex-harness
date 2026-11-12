import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startManagedAssistant } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';

const config = { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mail: true, calendar: true };
test('managed Microsoft login, agenda, persisted agent and reauthorization work without exposing tokens', async () => {
  const directory = await mkdtemp('/tmp/ms-setup-'); await mkdir(directory + '/assets'); await writeFile(directory + '/assets/index.html', 'Assistant');
  let stored: string | null = null;
  const integrationFetch = Object.assign(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/token')) return Response.json({ token_type: 'Bearer', access_token: 'private-ms-access', refresh_token: 'private-ms-refresh', expires_in: 3600, scope: 'User.Read Mail.ReadWrite Calendars.ReadWrite' });
    if (url.includes('/calendarView')) return Response.json({ value: [] });
    if (url.includes('/me?')) return Response.json({ id: 'account1', mail: 'owner@company.test' });
    throw new Error('UNEXPECTED_NETWORK');
  }, { preconnect: fetch.preconnect });
  const options = { assetsDirectory: directory + '/assets', integrationFetch, secrets: { async read() { return stored; }, async write(value: string) { stored = value; } }, validateProvider: async () => {},
    startHost: (input: Parameters<typeof startAssistantHost>[0]) => startAssistantHost({ ...input, engine: { ...input.engine, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Ready' }, { type: 'finish', finishReason: 'stop' }]] }) } }) };
  let app = await startManagedAssistant(directory + '/runtime', options);
  const request = (action: string, body?: unknown) => fetch(app.origin + '/api/' + action, { headers: { authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('token')}`, origin: app.origin, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const authorize = async (result: any) => {
    const auth = new URL(result.authorizationUrl), callback = new URL(auth.searchParams.get('redirect_uri')!);
    expect(auth.searchParams.get('scope')).not.toContain('Mail.Send');
    callback.searchParams.set('code', 'code'); callback.searchParams.set('state', auth.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    let state: any;
    for (let i = 0; i < 100; i++) { state = await (await request('setup')).json(); if (!state.calendar.pending) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('AUTH_TIMEOUT');
  };
  try {
    await request('setup/begin', {});
    await request('setup/provider', { baseURL: 'https://example.test/v1', apiKey: 'private-model', model: 'test', apiMode: 'chat' });
    expect((await request('setup/microsoft', { ...config, tenantId: 'common' })).status).toBe(400);
    const result = await (await request('setup/microsoft', config)).json();
    expect((await request('setup/start', {})).status).toBe(400);
    const state = await authorize(result); expect(state.microsoft).toMatchObject({ connected: true, email: 'owner@company.test' });
    expect(JSON.stringify(state)).not.toMatch(/private-ms|encryptionKey/);
    expect((await request('setup/calendar', { clientId: 'test.apps.googleusercontent.com' })).status).toBe(400);
    expect((await request('setup/start', {})).status).toBe(200);
    expect(await (await request('agenda')).json()).toMatchObject({ connected: true, events: [] });
    await app.close(); app = await startManagedAssistant(directory + '/runtime', options);
    const restored = await (await request('setup')).json() as any;
    expect(restored.ready).toBe(true); expect(restored.profiles[0].integrations).toMatchObject({ microsoft: true, outlookMail: true, outlookCalendar: true });
    const reconnect = await (await request('setup/microsoft-reconnect', { id: restored.profiles[0].id })).json();
    expect((await request('setup/begin', {})).status).toBe(400);
    expect((await authorize(reconnect)).ready).toBe(true);
    expect(await (await request('agenda')).json()).toMatchObject({ connected: true });
    await request('setup/begin', {}); const pending = await (await request('setup/microsoft', config)).json(); await authorize(pending);
    expect((await request('setup/microsoft-disconnect', {})).status).toBe(200);
    expect(await (await request('setup')).json()).toMatchObject({ microsoft: { connected: false } });
    expect((await authorize(await (await request('setup/microsoft', config)).json())).microsoft.connected).toBe(true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
