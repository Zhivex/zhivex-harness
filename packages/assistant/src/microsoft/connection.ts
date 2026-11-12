import { createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { openCalendarStore } from '../calendar/store.js';
import { startCalendarAuthorization } from '../calendar/oauth.js';
import type { CalendarFetch } from '../calendar/http.js';

export const microsoftConfigSchema = z.strictObject({ clientId: z.uuid(), tenantId: z.uuid(), mail: z.boolean(), calendar: z.boolean() }).refine(v => v.mail || v.calendar);
export interface MicrosoftOptions { clientId: string; tenantId: string; mail: boolean; calendar: boolean; encryptionKey: string; fetcher?: CalendarFetch; now?: () => number }
export const microsoftScopes = (options: Pick<MicrosoftOptions, 'mail' | 'calendar'>) => ['User.Read', ...(options.mail ? ['Mail.ReadWrite'] : []), ...(options.calendar ? ['Calendars.ReadWrite'] : [])];
export class MicrosoftHttpError extends Error { constructor(readonly status: number) { super(`MICROSOFT_HTTP_${status}`); } }
export async function microsoftJson(fetcher: CalendarFetch, url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw new MicrosoftHttpError(response.status); }
    if (!response.body) throw new Error();
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error(); } parts.push(part.value); } } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) { if (error instanceof MicrosoftHttpError) throw error; throw new Error('MICROSOFT_TRANSPORT_UNCERTAIN'); }
}
const credentialSchema = z.object({ connectionId: z.string(), accountId: z.string(), email: z.string(), clientId: z.string(), tenantId: z.string(), accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number(), scope: z.string() });
type Credentials = z.infer<typeof credentialSchema>;
export async function openMicrosoftConnection(directory: string, ownerId: string, options: MicrosoftOptions, recover = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ownerId)) throw new Error('MICROSOFT_OWNER_INVALID');
  microsoftConfigSchema.parse({ clientId: options.clientId, tenantId: options.tenantId, mail: options.mail, calendar: options.calendar });
  const root = path.join(directory, 'microsoft');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('MICROSOFT_STATE_UNSAFE');
  const store = await openCalendarStore(path.join(root, 'state'), options.encryptionKey, recover);
  try {
    if (store.meta('owner') && store.meta('owner') !== ownerId) throw new Error('MICROSOFT_OWNER_MISMATCH');
    store.set('owner', ownerId);
    const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
    const authority = `https://login.microsoftonline.com/${options.tenantId}/oauth2/v2.0`;
    const scopes = microsoftScopes(options), scope = `offline_access ${scopes.map(s => `https://graph.microsoft.com/${s}`).join(' ')}`;
    const hasScopes = (value: string) => scopes.every(s => value.split(' ').some(v => v.toLowerCase().replace('https://graph.microsoft.com/', '') === s.toLowerCase()));
    const tokenRequest = (fields: Record<string, string>) => microsoftJson(fetcher, `${authority}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.clientId, scope, ...fields }).toString() });
    const credentials = () => {
      const raw = store.decrypt('credentials'); if (!raw) throw new Error('MICROSOFT_NOT_CONNECTED');
      const value = credentialSchema.parse(raw);
      if (value.clientId !== options.clientId || value.tenantId !== options.tenantId) throw new Error('MICROSOFT_CLIENT_MISMATCH');
      if (!hasScopes(value.scope) || store.meta('reauthorize') === 'yes') throw new Error('MICROSOFT_REAUTHORIZE');
      return value;
    };
    const checkToken = (token: any) => {
      if (typeof token.access_token !== 'string' || !token.access_token || String(token.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || typeof token.scope !== 'string' || !hasScopes(token.scope)) throw new Error('MICROSOFT_CONSENT_INCOMPLETE');
    };
    let refreshing: Promise<Credentials> | undefined;
    const oauth = {
      credentials,
      async freshCredentials() {
        const old = credentials(); if (old.expiresAt > now() + 60_000) return old;
        refreshing ??= (async () => {
          try {
            const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refreshToken }); checkToken(token);
            if (store.decrypt<Credentials>('credentials')?.connectionId !== old.connectionId) throw new Error('MICROSOFT_CONNECTION_CHANGED');
            const updated = { ...old, accessToken: token.access_token, refreshToken: typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : old.refreshToken, expiresAt: now() + token.expires_in * 1000, scope: token.scope };
            store.encrypt('credentials', updated); return updated;
          } catch (error) { if (error instanceof MicrosoftHttpError && [400, 401].includes(error.status)) { store.set('reauthorize', 'yes'); throw new Error('MICROSOFT_REAUTHORIZE'); } throw error; }
        })();
        try { return await refreshing; } finally { refreshing = undefined; }
      },
      begin(redirectUri: string) {
        const uri = new URL(redirectUri);
        if (uri.protocol !== 'http:' || uri.hostname !== 'localhost' || !uri.port || uri.pathname !== '/oauth/callback' || uri.search || uri.hash || uri.username || uri.password) throw new Error('MICROSOFT_REDIRECT_INVALID');
        const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
        store.encrypt('oauth', { state, verifier, redirectUri, expiresAt: now() + 600_000 });
        return `${authority}/authorize?${new URLSearchParams({ client_id: options.clientId, response_type: 'code', response_mode: 'query', redirect_uri: redirectUri, scope, state, prompt: 'select_account', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`;
      },
      async complete(code: string, state: string) {
        const pending = store.decrypt<{ state: string; verifier: string; redirectUri: string; expiresAt: number }>('oauth');
        if (!pending || pending.state !== state || pending.expiresAt < now() || !code || code.length > 8192) throw new Error('MICROSOFT_OAUTH_STATE_INVALID');
        store.run("DELETE FROM meta WHERE key='oauth'");
        const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }); checkToken(token);
        if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('MICROSOFT_CONSENT_INCOMPLETE');
        const me = await microsoftJson(fetcher, 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { headers: { authorization: `Bearer ${token.access_token}` } });
        if (typeof me.id !== 'string' || !me.id || typeof (me.mail || me.userPrincipalName) !== 'string') throw new Error('MICROSOFT_ACCOUNT_INVALID');
        const previous = store.decrypt<Credentials>('credentials');
        if (previous && (previous.accountId !== me.id || previous.tenantId !== options.tenantId || previous.clientId !== options.clientId)) throw new Error('MICROSOFT_ACCOUNT_MISMATCH_DISCONNECT_FIRST');
        const value: Credentials = { connectionId: previous?.connectionId ?? randomBytes(16).toString('hex'), accountId: me.id, email: me.mail || me.userPrincipalName, clientId: options.clientId, tenantId: options.tenantId, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: now() + token.expires_in * 1000, scope: token.scope };
        store.encrypt('credentials', value); store.set('reauthorize', 'no');
        return { email: value.email, accountId: value.accountId };
      },
      async disconnect() { store.run("DELETE FROM meta WHERE key IN ('credentials','oauth')"); store.set('reauthorize', 'yes'); return { disconnected: true, revoked: false }; }
    };
    return { store, oauth, close: () => store.close() };
  } catch (error) { await store.close(); throw error; }
}
export const startMicrosoftAuthorization = (oauth: Awaited<ReturnType<typeof openMicrosoftConnection>>['oauth']) => startCalendarAuthorization(oauth, { hostname: 'localhost', provider: 'Microsoft', errorPrefix: 'MICROSOFT' });
