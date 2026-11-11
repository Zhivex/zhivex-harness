import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { CalendarStore } from './store.js';
import { googleJson, CalendarHttpError, type CalendarFetch } from './http.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const credentialsSchema = z.object({ connectionId: z.string(), accountId: z.string(), email: z.string(), clientId: z.string(),
  accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number(), scope: z.string() });
export type CalendarCredentials = z.infer<typeof credentialsSchema>;
export interface CalendarOAuthOptions { clientId: string; clientSecret?: string; fetcher?: CalendarFetch; now?: () => number }
export function createCalendarOAuth(store: CalendarStore, options: CalendarOAuthOptions) {
  if (!options.clientId.endsWith('.apps.googleusercontent.com')) throw new Error('CALENDAR_CLIENT_ID_INVALID');
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  const tokenRequest = (fields: Record<string, string>) => googleJson(fetcher, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, client_id: options.clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) }).toString()
  });
  const credentials = () => {
    const value = store.decrypt<CalendarCredentials>('credentials'); if (!value) throw new Error('CALENDAR_NOT_CONNECTED');
    const parsed = credentialsSchema.parse(value); if (parsed.clientId !== options.clientId) throw new Error('CALENDAR_CLIENT_MISMATCH');
    if (store.meta('reauthorize') === 'yes') throw new Error('CALENDAR_REAUTHORIZE'); return parsed;
  };
  let refreshing: Promise<CalendarCredentials> | undefined;
  const freshCredentials = async () => {
    const value = credentials(); if (value.expiresAt > now() + 60_000) return value;
    refreshing ??= (async () => {
      try {
        const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: value.refreshToken });
        if (token.token_type !== 'Bearer' || typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
          (token.scope && !token.scope.split(' ').includes(CALENDAR_SCOPE))) throw new Error('CALENDAR_TOKEN_INVALID');
        const updated = { ...value, accessToken: token.access_token, refreshToken: token.refresh_token ?? value.refreshToken,
          expiresAt: now() + token.expires_in * 1000 };
        if (store.decrypt<CalendarCredentials>('credentials')?.connectionId !== value.connectionId) throw new Error('CALENDAR_CONNECTION_CHANGED');
        store.encrypt('credentials', updated); return updated;
      } catch (error) { if (error instanceof CalendarHttpError && [400,401].includes(error.status)) { store.set('reauthorize', 'yes'); throw new Error('CALENDAR_REAUTHORIZE'); } throw error; }
    })();
    try { return await refreshing; } finally { refreshing = undefined; }
  };
  return {
    credentials, freshCredentials,
    begin(redirectUri: string) {
      const target = new URL(redirectUri);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/oauth/callback' || !target.port || target.search || target.hash || target.username || target.password) throw new Error('CALENDAR_REDIRECT_INVALID');
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      store.encrypt('oauth', { state, verifier, redirectUri, expiresAt: now() + 10 * 60_000 });
      const params = new URLSearchParams({ client_id: options.clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: `openid email ${CALENDAR_SCOPE}`, state, access_type: 'offline', prompt: 'consent',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },
    async complete(code: string, state: string) {
      const pending = store.decrypt<{ state: string; verifier: string; redirectUri: string; expiresAt: number }>('oauth');
      if (!pending || pending.state !== state || pending.expiresAt < now() || !code || code.length > 4096) throw new Error('CALENDAR_OAUTH_STATE_INVALID');
      store.run("DELETE FROM meta WHERE key='oauth'"); // one-shot before exchanging a code
      const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
      if (token.token_type !== 'Bearer' || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
        typeof token.scope !== 'string' || !token.scope.split(' ').includes(CALENDAR_SCOPE)) throw new Error('CALENDAR_CONSENT_INCOMPLETE');
      const identity = await googleJson(fetcher, 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } });
      if (typeof identity.sub !== 'string' || !identity.sub || typeof identity.email !== 'string' || identity.email_verified !== true) throw new Error('CALENDAR_ACCOUNT_INVALID');
      const previous = store.decrypt<CalendarCredentials>('credentials');
      if (previous && previous.accountId !== identity.sub) throw new Error('CALENDAR_ACCOUNT_MISMATCH_DISCONNECT_FIRST');
      const value: CalendarCredentials = { connectionId: previous?.connectionId ?? randomBytes(16).toString('hex'), accountId: identity.sub, email: identity.email,
        clientId: options.clientId, accessToken: token.access_token, refreshToken: token.refresh_token,
        expiresAt: now() + token.expires_in * 1000, scope: token.scope };
      store.encrypt('credentials', value); store.set('reauthorize', 'no');
      return { accountId: value.accountId, email: value.email, connectionId: value.connectionId };
    },
    async disconnect() {
      const value = store.decrypt<CalendarCredentials>('credentials');
      if (!value) return { disconnected: true, revoked: true };
      // Disable local access even if Google is unreachable; never expose the token in errors.
      store.run("DELETE FROM meta WHERE key IN ('credentials','oauth')"); store.set('reauthorize', 'yes');
      try { const response = await fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: value.refreshToken }).toString(), signal: AbortSignal.timeout(20_000) });
        return { disconnected: true, revoked: response.ok }; } catch { return { disconnected: true, revoked: false }; }
    }
  };
}

/** Loopback callback; no auth codes/tokens are printed or sent to Telegram. */
export async function startCalendarAuthorization(oauth: ReturnType<typeof createCalendarOAuth>) {
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  const result = new Promise<unknown>((resolve, reject) => { finish = resolve; fail = reject; });
  let busy = false; let expectedHost = '';
  const server = createServer((req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${expectedHost}`); }
    catch { res.writeHead(400); res.end('Invalid callback'); return; }
    if (req.method !== 'GET' || req.headers.host !== expectedHost || url.pathname !== '/oauth/callback' || busy) { res.writeHead(400); res.end('Invalid callback'); return; }
    busy = true;
    void oauth.complete(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '').then(value => {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('Calendar connected. You may close this window.'); finish(value);
    }, () => { res.writeHead(400); res.end('Authorization failed. Restart local connection setup.'); fail(new Error('CALENDAR_AUTHORIZATION_FAILED')); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('CALENDAR_CALLBACK_FAILED');
  expectedHost = `127.0.0.1:${address.port}`;
  const url = oauth.begin(`http://${expectedHost}/oauth/callback`);
  const timer = setTimeout(() => fail(new Error('CALENDAR_AUTHORIZATION_TIMEOUT')), 10 * 60_000);
  return { url, result: result.finally(() => { clearTimeout(timer); server.close(); server.closeAllConnections(); }), close() { fail(new Error('CALENDAR_AUTHORIZATION_CANCELLED')); } };
}
