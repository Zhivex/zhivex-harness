import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';

test('Calendar OAuth authorization is discovered through coordinator, rejects wrong state and clears after cancel or completion', async () => {
  const directory = await mkdtemp('/tmp/zhx-calendar-app-'); let saved: string | null = null, exchanges = 0;
  const integrationFetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      exchanges++; expect(String(init?.body)).toContain('code_verifier=');
      return Response.json({token_type: 'Bearer', access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events'});
    }
    if (url.endsWith('/userinfo')) return Response.json({sub: 'fixture-account', email: 'owner@example.test', email_verified: true});
    throw new Error('Unexpected external request');
  }, {preconnect: fetch.preconnect});
  const owner = await startApplicationCoordinator(directory, {integrationFetch, secrets: {async read() {return saved;}, async write(value) {saved = value;}}});
  const client = await connectCoordinator(directory);
  const settled = async () => {for (let i = 0; i < 100; i++) {if (!(await client.state()).state.calendar.pending) return; await new Promise(resolve => setTimeout(resolve, 10));} throw new Error('OAUTH_NOT_SETTLED');};
  const begin = () => client.call('action', {name: 'calendar', value: {clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'private-client-secret'}});
  try {
    expect(await client.call('authorization')).toEqual({url: null});
    await client.call('action', {name: 'begin', value: {}}); await begin();
    const first = new URL((await client.call<{url: string}>('authorization')).url);
    expect(first.hostname).toBe('accounts.google.com'); expect(first.searchParams.get('code_challenge_method')).toBe('S256');
    await client.call('action', {name: 'calendar-cancel', value: {}}); await settled(); expect(await client.call('authorization')).toEqual({url: null}); expect(exchanges).toBe(0);
    await begin(); const second = new URL((await client.call<{url: string}>('authorization')).url); expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
    const callback = new URL(second.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', first.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(400); expect(exchanges).toBe(0);
    callback.searchParams.set('state', second.searchParams.get('state')!); expect((await fetch(callback)).status).toBe(200); await settled();
    expect((await client.state()).state.calendar).toMatchObject({connected: true, pending: false, email: 'owner@example.test'});
    expect(await client.call('authorization')).toEqual({url: null}); expect(exchanges).toBe(1);
    const publicState = JSON.stringify(await client.state()); for (const secret of ['private-access', 'private-refresh', 'private-client-secret']) expect(publicState).not.toContain(secret);
  } finally {await owner.close(); await rm(directory, {recursive: true, force: true});}
});
