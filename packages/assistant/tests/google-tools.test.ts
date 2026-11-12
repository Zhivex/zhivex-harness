import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { openGoogleConnection, googleScopes, createGoogleTools } from '../src/integrations/google.js';
import { createGoogleModule } from '../src/modules/google.js';
import type { CalendarFetch } from '../src/calendar/http.js';

async function fixture() {
  const directory = await mkdtemp('/tmp/google-tools-'); let now = Date.now(), posts = 0, refreshes = 0, lost = false, changed = false, badScope = false;
  let raw = '', driveQuery = '';
  const fetcher: CalendarFetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/token') {
      if (new URLSearchParams(String(init.body)).get('grant_type') === 'refresh_token') refreshes++;
      return Response.json({ token_type: 'Bearer', access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 3600, scope: badScope ? 'openid' : googleScopes({ mail: true, drive: true }).join(' ') });
    }
    if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: 'owner-account', email: 'owner@example.com', email_verified: true });
    if (u.pathname.endsWith('/revoke')) return new Response('');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-private'); expect(init.redirect).toBe('error');
    if (u.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'message1', threadId: 'thread1' }], nextPageToken: u.searchParams.has('pageToken') ? undefined : 'next', resultSizeEstimate: 2 });
    if (u.pathname.endsWith('/threads/thread1')) return Response.json({ messages: [
      { id: 'message1', internalDate: '1794384000000', labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'owner@example.com' }, { name: 'Subject', value: 'Planning' }, { name: 'Message-ID', value: '<message1@example.com>' }, { name: 'References', value: '<older@example.com>' }], body: { data: Buffer.from('Meet tomorrow').toString('base64url') } } },
      ...(changed ? [{ id: 'message2' }] : [])
    ] });
    if (u.pathname.endsWith('/drafts')) {
      posts++; const body = JSON.parse(String(init.body)); expect(body.message.threadId).toBe('thread1'); raw = Buffer.from(body.message.raw, 'base64url').toString('utf8');
      if (lost) throw new Error('lost after creating');
      return Response.json({ id: 'draft1', message: { threadId: 'thread1' } });
    }
    if (u.pathname === '/drive/v3/files') { driveQuery = u.searchParams.get('q')!; return Response.json({ files: [{ id: 'doc1', name: 'Notes', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc1/edit' }], nextPageToken: 'drive-next' }); }
    if (u.pathname.endsWith('/doc1/export')) return new Response('A decision with a source.');
    if (u.pathname.endsWith('/doc1')) return Response.json({ id: 'doc1', name: 'Notes', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc1/edit' });
    if (u.pathname.endsWith('/pdf1')) return Response.json({ id: 'pdf1', mimeType: 'application/pdf' });
    throw new Error('UNEXPECTED_REQUEST');
  };
  const options = { mail: true, drive: true, encryptionKey: randomBytes(32).toString('base64'), clientId: 'test.apps.googleusercontent.com', fetcher, now: () => now };
  let connection = await openGoogleConnection(directory, 'owner', options);
  const url = new URL(connection.oauth.begin('http://127.0.0.1:12345/oauth/callback'));
  await connection.oauth.complete('code', url.searchParams.get('state')!);
  let service = createGoogleTools(connection, options);
  return { directory, options, url, get connection() { return connection; }, get service() { return service; }, get posts() { return posts; }, get refreshes() { return refreshes; }, get raw() { return raw; }, get driveQuery() { return driveQuery; },
    loseResponse() { lost = true; }, changeThread() { changed = true; }, expire() { now += 3600_000; }, revokeScope() { badScope = true; },
    async restart() { await connection.close(); connection = await openGoogleConnection(directory, 'owner', options); service = createGoogleTools(connection, options); },
    async close() { await connection.close(); await rm(directory, { recursive: true, force: true }); }
  };
}
const draft = () => ({ requestId: randomUUID(), to: ['guest@example.com'], subject: 'Re: Planning', body: 'Confirmado, gracias.', threadId: 'thread1', replyToMessageId: 'message1' });

test('Google consent has explicit scopes, refreshes once, persists encrypted tokens and rejects missing scopes', async () => {
  const f = await fixture();
  try {
    expect(f.url.searchParams.get('scope')).toContain('gmail.compose'); expect(f.url.searchParams.get('scope')).toContain('drive.readonly'); expect(f.url.searchParams.get('scope')).not.toContain('calendar.events');
    f.expire(); await Promise.all([f.service.searchMail({ query: 'is:unread' }), f.service.searchMail({ query: 'in:inbox' })]); expect(f.refreshes).toBe(1);
    const bytes = await readFile(f.directory + '/google/state/calendar.sqlite'); expect(bytes.includes(Buffer.from('refresh-private'))).toBe(false);
    f.expire(); f.revokeScope(); await expect(f.service.searchMail({ query: 'in:inbox' })).rejects.toThrow('TOKEN_INVALID');
  } finally { await f.close(); }
});

test('Gmail paginates, reads threads and creates the exact reply draft only once across restart', async () => {
  const f = await fixture();
  try {
    expect(await f.service.searchMail({ query: 'is:unread' })).toMatchObject({ nextPageToken: 'next' });
    expect(await f.service.searchMail({ query: 'is:unread', pageToken: 'next' })).toMatchObject({ nextPageToken: null });
    expect(await f.service.readThread({ threadId: 'thread1' })).toMatchObject({ messages: [{ id: 'message1', text: 'Meet tomorrow' }] });
    const input = draft(); expect(await f.service.createDraft(input)).toMatchObject({ status: 'confirmed', draftId: 'draft1' });
    expect(f.raw).toContain('To: guest@example.com'); expect(f.raw).toContain('In-Reply-To: <message1@example.com>'); expect(f.raw).toContain('References: <older@example.com> <message1@example.com>');
    expect(f.raw).toContain(Buffer.from(input.body).toString('base64'));
    await f.restart(); expect(await f.service.createDraft(input)).toMatchObject({ status: 'confirmed' }); expect(f.posts).toBe(1);
    await expect(f.service.createDraft({ ...input, to: ['changed@example.com'] })).rejects.toThrow('REQUEST_CONFLICT');
    await expect(f.service.createDraft({ ...draft(), subject: 'Wrong' })).rejects.toThrow('SUBJECT_MISMATCH');
    await expect(f.service.createDraft({ ...draft(), to: ['guest@example.com\r\nBcc: evil@example.com'] })).rejects.toThrow();
    f.changeThread(); await expect(f.service.createDraft(draft())).rejects.toThrow('THREAD_CHANGED'); expect(f.posts).toBe(1);
  } finally { await f.close(); }
});

test('uncertain Gmail draft is journaled and never automatically resent after restart', async () => {
  const f = await fixture();
  try {
    f.loseResponse(); const input = draft(); expect(await f.service.createDraft(input)).toMatchObject({ status: 'uncertain' });
    await f.restart(); expect(await f.service.createDraft(input)).toMatchObject({ status: 'uncertain' }); expect(f.posts).toBe(1);
    expect(f.service.draftStatus({ requestId: input.requestId })).toMatchObject({ status: 'uncertain' });
  } finally { await f.close(); }
});

test('Drive search escapes query literals, preserves source links and reads only supported text formats', async () => {
  const f = await fixture();
  try {
    expect(await f.service.searchDrive({ query: "Bob's notes" })).toMatchObject({ nextPageToken: 'drive-next', files: [{ webViewLink: 'https://docs.google.com/document/d/doc1/edit' }] });
    expect(f.driveQuery).toContain("Bob\\'s notes");
    expect(await f.service.readFile({ fileId: 'doc1' })).toMatchObject({ text: 'A decision with a source.', truncated: false });
    await expect(f.service.readFile({ fileId: 'pdf1' })).rejects.toThrow('TEXT_FORMAT_REQUIRED');
    await expect(f.service.readFile({ fileId: '../private' })).rejects.toThrow();
    await f.connection.close();
    const module = await createGoogleModule(f.options).open({ directory: f.directory, ownerId: 'owner', recover: false });
    try {
      expect(module.profile.toolNames).toContain('google_write_mail_create_draft');
      expect(module.profile.toolNames.some(name => name.includes('send'))).toBe(false);
      expect(JSON.stringify(module.mcpConfiguration)).not.toContain('access-private');
    } finally { await module.close(); }
  } finally { await f.close(); }
});


test('proactive Gmail uses metadata for the full thread and rejects incomplete message metadata', async () => {
  const f = await fixture();
  try {
    expect(await f.service.readReplyThread('thread1', AbortSignal.timeout(1000))).toMatchObject({ complete: true, messages: [{ id: 'message1', at: 1794384000000, draft: false }] });
    expect(f.posts).toBe(0);
    f.changeThread(); await expect(f.service.readReplyThread('thread1', AbortSignal.timeout(1000))).rejects.toThrow('THREAD_INVALID');
  } finally { await f.close(); }
});
