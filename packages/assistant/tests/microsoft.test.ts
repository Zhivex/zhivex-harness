import { normalizeHarnessMcpConfiguration } from '@zhivex-ai/harness/engine';
import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { openMicrosoftConnection, microsoftScopes, startMicrosoftAuthorization } from '../src/microsoft/connection.js';
import { createMicrosoftTools } from '../src/microsoft/tools.js';
import { createMicrosoftModule } from '../src/modules/microsoft.js';
const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture() {
  const directory = await mkdtemp('/tmp/ms-tools-');
  let now = Date.now(), refreshes = 0, posts = 0, lost = false, badPage = false, revoked = false, incomplete = false, account = 'account1';
  const payloads: any[] = [], calls: string[] = [];
  const options = { clientId, tenantId, encryptionKey: randomBytes(32).toString('base64'), mail: true, calendar: true, now: () => now,
    fetcher: async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); calls.push(String(input)); expect(init.redirect).toBe('error');
      if (url.pathname.endsWith('/token')) {
        const form = new URLSearchParams(String(init.body)); expect(form.has('client_secret')).toBe(false);
        if (form.get('grant_type') === 'refresh_token') { refreshes++; if (revoked) return Response.json({}, { status: 400 }); }
        else expect(form.get('code_verifier')?.length).toBeGreaterThan(40);
        return Response.json({ token_type: 'Bearer', access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, scope: incomplete ? 'User.Read' : microsoftScopes(options).join(' ') });
      }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-access');
      if (url.pathname === '/v1.0/me') return Response.json({ id: account, mail: 'owner@company.test' });
      if (init.method === 'POST') { posts++; payloads.push(JSON.parse(String(init.body))); if (lost) throw new Error('lost'); return Response.json({ id: `created${posts}`, isDraft: true, webLink: 'https://outlook.office.com/' }); }
      if (url.pathname === '/v1.0/me/messages') return Response.json({ value: [{ id: 'msg1', subject: 'Planning' }], ...(!url.searchParams.has('$skip') ? { '@odata.nextLink': badPage ? 'https://evil.test/v1.0/me/messages' : 'https://graph.microsoft.com/v1.0/me/messages?$skip=20' } : {}) });
      if (url.pathname === '/v1.0/me/messages/msg1') return Response.json({ id: 'msg1', body: { contentType: 'text', content: 'x'.repeat(25000) }, hasAttachments: true });
      if (url.pathname === '/v1.0/me/calendarView') return Response.json({ value: [{ id: 'event1', subject: 'Planning', start: { dateTime: '2026-11-12T12:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-12T13:00:00.0000000', timeZone: 'UTC' }, showAs: 'free' }] });
      throw new Error('UNEXPECTED_NETWORK');
    } };
  let connection = await openMicrosoftConnection(directory, 'owner', options);
  const auth = new URL(connection.oauth.begin('http://localhost:12345/oauth/callback'));
  await connection.oauth.complete('code', auth.searchParams.get('state')!);
  let service = createMicrosoftTools(connection, options);
  return { directory, options, auth, payloads, calls, get service() { return service; }, get connection() { return connection; }, get refreshes() { return refreshes; }, get posts() { return posts; }, expire() { now += 3600000; }, lose() { lost = true; }, badPage() { badPage = true; }, revoke() { revoked = true; }, incomplete() { incomplete = true; }, changeAccount() { account = 'other'; },
    async restart() { await connection.close(); connection = await openMicrosoftConnection(directory, 'owner', options); service = createMicrosoftTools(connection, options); },
    async close() { await connection.close(); await rm(directory, { recursive: true, force: true }); } };
}
const draft = () => ({ requestId: randomUUID(), to: ['person@company.test'], subject: 'Plan', body: 'Hola' });
const window = { timeMin: '2026-11-12T00:00:00-03:00', timeMax: '2026-11-13T00:00:00-03:00' };

test('Microsoft uses tenant-bound PKCE, encrypted tokens, deduplicated refresh and rejects revoked consent', async () => {
  const f = await fixture(); try {
    expect(f.auth.hostname).toBe('login.microsoftonline.com'); expect(f.auth.pathname).toContain(tenantId);
    expect(f.auth.searchParams.get('code_challenge_method')).toBe('S256'); expect(f.auth.searchParams.get('scope')).toContain('offline_access'); expect(f.auth.searchParams.get('scope')).not.toContain('Mail.Send');
    const db = await readFile(f.directory + '/microsoft/state/calendar.sqlite'); expect(db.includes(Buffer.from('secret-refresh'))).toBe(false); expect(db.includes(Buffer.from('secret-access'))).toBe(false);
    f.expire(); await Promise.all([f.service.listMail({}), f.service.listMail({})]); expect(f.refreshes).toBe(1);
    f.expire(); f.revoke(); await expect(f.service.listMail({})).rejects.toThrow('MICROSOFT_REAUTHORIZE');
  } finally { await f.close(); }
});
test('Microsoft rejects incomplete consent, foreign account and OAuth state replay', async () => {
  const f = await fixture(); try {
    await expect(f.connection.oauth.complete('code', f.auth.searchParams.get('state')!)).rejects.toThrow('STATE_INVALID');
    let auth = new URL(f.connection.oauth.begin('http://localhost:12345/oauth/callback'));
    await expect(f.connection.oauth.complete('code', 'wrong')).rejects.toThrow('STATE_INVALID');
    f.changeAccount(); await expect(f.connection.oauth.complete('code', auth.searchParams.get('state')!)).rejects.toThrow('ACCOUNT_MISMATCH');
    auth = new URL(f.connection.oauth.begin('http://localhost:12345/oauth/callback')); f.incomplete();
    await expect(f.connection.oauth.complete('code', auth.searchParams.get('state')!)).rejects.toThrow('CONSENT_INCOMPLETE');
  } finally { await f.close(); }
});
test('Outlook paginates with bound opaque tokens, rejects foreign URLs and truncates message content', async () => {
  const f = await fixture(); try {
    const first = await f.service.listMail({}); expect(first.nextPageToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.service.listMail({ pageToken: first.nextPageToken! })).toMatchObject({ nextPageToken: null });
    await expect(f.service.listMail({ query: 'different', pageToken: first.nextPageToken! })).rejects.toThrow('PAGE_INVALID');
    await expect(f.service.listMail({ pageToken: 'https://evil.test' })).rejects.toThrow('PAGE_INVALID');
    expect(await f.service.readMail({ messageId: 'msg1' })).toMatchObject({ truncated: true, attachmentsLoaded: false });
    f.badPage(); await expect(f.service.listMail({})).rejects.toThrow('PAGE_INVALID'); expect(f.calls.some(v => v.startsWith('https://evil'))).toBe(false);
  } finally { await f.close(); }
});
test('drafts contain exact approved fields, never send, and survive restart without duplication', async () => {
  const f = await fixture(); try {
    const args = draft(); expect(await f.service.createDraft(args)).toMatchObject({ status: 'confirmed', kind: 'draft' });
    expect(f.payloads[0]).toEqual({ subject: args.subject, body: { contentType: 'Text', content: args.body }, toRecipients: [{ emailAddress: { address: args.to[0] } }], ccRecipients: [] });
    await f.restart(); expect(await f.service.createDraft(args)).toMatchObject({ status: 'confirmed' }); expect(f.posts).toBe(1);
    await expect(f.service.createDraft({ ...args, subject: 'Changed' })).rejects.toThrow('REQUEST_CONFLICT');
    expect(f.calls.some(v => /sendMail|\/send/.test(v))).toBe(false);
  } finally { await f.close(); }
});
test('uncertain and concurrent Outlook writes never automatically dispatch twice', async () => {
  const f = await fixture(); try {
    f.lose(); const args = draft(); const results = await Promise.allSettled([f.service.createDraft(args), f.service.createDraft(args)]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true); expect(f.posts).toBe(1);
    await f.restart(); expect(await f.service.createDraft(args)).toMatchObject({ status: 'uncertain' }); expect(f.posts).toBe(1);
    expect(f.service.operationStatus({ requestId: args.requestId })).toMatchObject({ status: 'uncertain' });
  } finally { await f.close(); }
});
test('calendar expands a date window and creates an offset-correct appointment without invitations', async () => {
  const f = await fixture(); try {
    const page = await f.service.listEvents(window); expect(page.events[0]).toMatchObject({ busy: false, start: { dateTime: '2026-11-12T12:00:00.0000000Z' } });
    const args = { requestId: randomUUID(), subject: 'Focus', start: '2026-11-12T09:00:00-03:00', end: '2026-11-12T10:00:00-03:00' };
    expect(await f.service.createEvent(args)).toMatchObject({ status: 'confirmed', kind: 'event' });
    expect(f.payloads[0].start).toEqual({ dateTime: '2026-11-12T12:00:00.000', timeZone: 'UTC' }); expect(f.payloads[0].attendees).toBeUndefined(); expect(f.payloads[0].transactionId).toBe(args.requestId);
    await f.restart(); await f.service.createEvent(args); expect(f.posts).toBe(1);
    expect(() => f.service.createEvent({ ...args, start: args.end })).toThrow();
  } finally { await f.close(); }
});
test('Microsoft module separates reads from approved writes and supplies the web agenda', async () => {
  const f = await fixture(); try {
    await f.connection.close(); const instance = await createMicrosoftModule(f.options).open({ directory: f.directory, ownerId: 'owner', recover: false });
    try {
      const write = normalizeHarnessMcpConfiguration(instance.mcpConfiguration).servers.find(v => v.name === 'microsoft_write')!; expect(write.permissions).toEqual(['write']);
      expect(write.includeTools).toEqual(['apply']);
      expect(await instance.agendaSource!.list(window)).toMatchObject({ complete: true });
      expect(JSON.stringify(instance.profile)).not.toContain('secret-access');
    } finally { await instance.close(); }
  } finally { await f.close(); }
});
test('Microsoft loopback callback rejects wrong state without consuming the valid login', async () => {
  const f = await fixture(); try {
    const flow = await startMicrosoftAuthorization(f.connection.oauth), auth = new URL(flow.url), callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'code'); callback.searchParams.set('state', 'wrong'); expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set('state', auth.searchParams.get('state')!); expect((await fetch(callback)).status).toBe(200); expect(await flow.result).toMatchObject({ email: 'owner@company.test' });
  } finally { await f.close(); }
});

test('Outlook draft waits for exact human approval and executes once after host restart', async () => {
  const { createMockLanguageModel } = await import('@zhivex-ai/agents/testing');
  const { startAssistantHost } = await import('../src/host.js');
  const { connectAssistant } = await import('../src/client.js');
  const f = await fixture(), args = { ...draft(), cc: [] }; let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    const reference = f.service.proposeDraft(args);
    await f.connection.close();
    host = await startAssistantHost({ directory: f.directory, ownerId: 'owner', modules: [createMicrosoftModule(f.options)], engine: { modelInstance: createMockLanguageModel({ streamEvents: [
      [{ type: 'tool-call', toolCall: { id: 'draft1', name: 'microsoft_write_apply', input: reference } }, { type: 'finish', finishReason: 'tool-calls' }],
      [{ type: 'text-delta', textDelta: 'Draft created' }, { type: 'finish', finishReason: 'stop' }]
    ] }) } });
    let client = await connectAssistant(host.credentialsPath);
    const created = await client.command({ method: 'session.create', title: 'Outlook', idempotencyKey: 'session' });
    if (!created.ok || created.data.kind !== 'session') throw new Error('SESSION_FAILED');
    const session = created.data.session;
    const pending = await client.command({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Prepare a draft' });
    expect(pending).toMatchObject({ ok: true, data: { run: { status: 'waiting_approval' } } }); expect(f.posts).toBe(0);
    if (!pending.ok || pending.data.kind !== 'run') throw new Error('RUN_FAILED');
    await host.close();
    host = await startAssistantHost({ directory: f.directory, ownerId: 'owner', modules: [createMicrosoftModule(f.options)], engine: { modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Draft created' }, { type: 'finish', finishReason: 'stop' }]] }) } });
    client = await connectAssistant(host.credentialsPath);
    const current = await client.command({ method: 'run.get', sessionId: session.sessionId, runId: pending.data.run.runId, includeReview: true });
    if (!current.ok || current.data.kind !== 'run') throw new Error('RUN_FAILED');
    const details = await host.approvalDetails!(current.data.run); expect(JSON.stringify(details)).toContain(args.to[0]!); expect(JSON.stringify(details)).toContain(args.body);
    const decision = { method: 'approval.resolve' as const, sessionId: session.sessionId, runId: current.data.run.runId, expectedRevision: current.data.run.revision, idempotencyKey: 'approve', decisions: current.data.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) };
    const resolved = await client.command(decision); expect(resolved).toMatchObject({ ok: true }); await client.command(decision); expect(f.posts).toBe(1);
  } finally { await host?.close(); await f.close(); }
});

test('encrypted Microsoft proposals reject edits, forged references and expiration', async () => {
  const f = await fixture(); try {
    const args = draft(), reference = f.service.proposeDraft(args);
    expect(f.service.proposeDraft(args)).toEqual(reference);
    expect(() => f.service.proposeDraft({ ...args, to: ['other@company.test'] })).toThrow('REQUEST_CONFLICT');
    expect(() => f.service.apply({ ...reference, proposalDigest: '0'.repeat(64) })).toThrow('PROPOSAL_INVALID');
    const db = await readFile(f.directory + '/microsoft/state/calendar.sqlite'); expect(db.includes(Buffer.from(args.to[0]!))).toBe(false);
    await f.restart(); expect(f.service.review(reference)).toMatchObject({ args: { to: args.to }, account: 'owner@company.test' });
    f.expire(); expect(() => f.service.apply(reference)).toThrow('PROPOSAL_EXPIRED'); expect(f.posts).toBe(0);
  } finally { await f.close(); }
});
