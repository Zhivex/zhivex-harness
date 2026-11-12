import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openCalendarConnection, type CalendarConnectionOptions } from '../calendar/connection.js';
import { googleJson } from '../calendar/http.js';
import { requestId } from '../daily/service.js';

export interface GoogleToolsOptions extends CalendarConnectionOptions { mail?: boolean; drive?: boolean }
export const googleScopes = (options: Pick<GoogleToolsOptions, 'mail' | 'drive'>) => [
  ...(options.mail ? ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'] : []),
  ...(options.drive ? ['https://www.googleapis.com/auth/drive.readonly'] : [])
];
export function openGoogleConnection(directory: string, ownerId: string, options: GoogleToolsOptions, recover = false) {
  if (!options.mail && !options.drive) throw new Error('GOOGLE_TOOLS_REQUIRED');
  return openCalendarConnection(path.join(directory, 'google'), ownerId, { ...options, requiredScopes: googleScopes(options) }, recover);
}
const googleId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const mailSearchSchema = z.strictObject({ query: z.string().min(1).max(500), pageToken: z.string().max(2048).optional() });
export const threadSchema = z.strictObject({ threadId: googleId });
export const draftSchema = z.strictObject({ requestId, to: z.array(z.email().max(254)).min(1).max(20),
  subject: z.string().min(1).max(500).regex(/^[^\r\n\x00]+$/), body: z.string().max(16000),
  threadId: googleId.optional(), replyToMessageId: googleId.optional()
}).refine(input => Boolean(input.threadId) === Boolean(input.replyToMessageId), 'A reply requires both threadId and replyToMessageId.');
export const driveSearchSchema = z.strictObject({ query: z.string().min(1).max(200), pageToken: z.string().max(2048).optional() });
export const fileSchema = z.strictObject({ fileId: googleId });
const headerValue = (message: any, name: string): string => String((message.payload?.headers ?? []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? '');
function encodedSubject(subject: string) {
  const words: string[] = []; let current = '';
  for (const character of subject) {
    if (Buffer.byteLength(current + character) > 42) { words.push(current); current = ''; }
    current += character;
  }
  if (current) words.push(current);
  return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}
function messageText(payload: any, depth = 0): string {
  if (!payload || depth > 10) return '';
  if (payload.mimeType === 'text/plain' && typeof payload.body?.data === 'string') return Buffer.from(payload.body.data.slice(0, 30000), 'base64url').toString('utf8').slice(0, 16000);
  return (payload.parts ?? []).slice(0, 20).map((part: any) => messageText(part, depth + 1)).join('\n').slice(0, 16000);
}

export function createGoogleTools(connection: Awaited<ReturnType<typeof openGoogleConnection>>, options: GoogleToolsOptions) {
  const { oauth, store } = connection, fetcher = options.fetcher ?? fetch;
  const identity = oauth.credentials();
  const binding = createHash('sha256').update(JSON.stringify({ accountId: identity.accountId, connectionId: identity.connectionId, scopes: googleScopes(options) })).digest('hex');
  store.run('CREATE TABLE IF NOT EXISTS mail_drafts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT)');
  store.run("UPDATE mail_drafts SET status='uncertain' WHERE status='sending'");
  const auth = async () => {
    const credentials = await oauth.freshCredentials();
    if (credentials.connectionId !== identity.connectionId || credentials.accountId !== identity.accountId) throw new Error('GOOGLE_CONNECTION_CHANGED');
    return { authorization: `Bearer ${credentials.accessToken}` };
  };
  const get = async (url: string, signal?: AbortSignal) => googleJson(fetcher, url, { headers: await auth() }, signal);
  const mail = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const rawThread = (id: string, signal?: AbortSignal) => get(`${mail}/threads/${encodeURIComponent(id)}?format=full`, signal);
  return {
    binding,
    async readReplyThread(threadId: string, signal: AbortSignal) {
      if (!options.mail) throw new Error('GOOGLE_MAIL_DISABLED');
      googleId.parse(threadId);
      const result = await get(`${mail}/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`, signal);
      if (!Array.isArray(result.messages) || result.messages.length > 1000) throw new Error('PROACTIVE_THREAD_INCOMPLETE');
      return { complete: true, messages: result.messages.map((m: any) => {
        if (typeof m.id !== 'string' || typeof m.internalDate !== 'string' || !/^\d+$/.test(m.internalDate) || !Number.isFinite(Number(m.internalDate)) || !Array.isArray(m.labelIds) || !headerValue(m, 'from')) throw new Error('PROACTIVE_THREAD_INVALID');
        return { id: m.id, from: headerValue(m, 'from'), at: Number(m.internalDate), draft: m.labelIds.includes('DRAFT') };
      }) };
    },
    async searchMail(input: unknown, signal?: AbortSignal) {
      const args = mailSearchSchema.parse(input), params = new URLSearchParams({ q: args.query, maxResults: '20', ...(args.pageToken ? { pageToken: args.pageToken } : {}) });
      const result = await get(`${mail}/messages?${params}`, signal);
      return { messages: result.messages ?? [], nextPageToken: result.nextPageToken ?? null, resultSizeEstimate: result.resultSizeEstimate, source: 'Gmail' };
    },
    async readThread(input: unknown, signal?: AbortSignal) {
      const { threadId } = threadSchema.parse(input), result = await rawThread(threadId, signal);
      return { threadId, url: `https://mail.google.com/mail/u/0/#all/${threadId}`, truncated: (result.messages?.length ?? 0) > 20,
        messages: (result.messages ?? []).slice(-20).map((m: any) => ({ id: m.id, from: headerValue(m, 'from'), to: headerValue(m, 'to'), subject: headerValue(m, 'subject'), date: headerValue(m, 'date'), text: messageText(m.payload), snippet: m.snippet })) };
    },
    async createDraft(input: unknown, signal?: AbortSignal) {
      const args = draftSchema.parse(input), digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
      const prior = store.get<{ digest: string; status: string; result: string | null }>('SELECT * FROM mail_drafts WHERE id=?', args.requestId);
      if (prior) {
        if (prior.digest !== digest) throw new Error('MAIL_REQUEST_CONFLICT');
        return { status: prior.status, ...(prior.result ? JSON.parse(prior.result) : {}), requestId: args.requestId };
      }
      let replyHeaders: string[] = [];
      if (args.threadId) {
        const thread = await rawThread(args.threadId, signal), messages = thread.messages ?? [], parent = messages.find((m: any) => m.id === args.replyToMessageId);
        if (!parent || messages.at(-1)?.id !== args.replyToMessageId) throw new Error('MAIL_THREAD_CHANGED');
        const subject = headerValue(parent, 'subject').replace(/^(?:re:\s*)+/i, '').trim();
        if (args.subject.replace(/^(?:re:\s*)+/i, '').trim() !== subject) throw new Error('MAIL_SUBJECT_MISMATCH');
        const messageId = headerValue(parent, 'message-id'), references = headerValue(parent, 'references');
        if (!/^<[^<>\s]+>$/.test(messageId) || messageId.length > 254 || /[\r\n\x00]/.test(references) || references.length > 700) throw new Error('MAIL_REPLY_HEADERS_INVALID');
        replyHeaders = [`In-Reply-To: ${messageId}`, `References: ${references ? references + ' ' : ''}${messageId}`];
      }
      const headers = await auth(); signal?.throwIfAborted();
      // No request is repeated after crossing the dispatch boundary, including process death.
      if (store.get<{ n: number }>('SELECT COUNT(*) n FROM mail_drafts')!.n >= 10000) throw new Error('MAIL_CAPACITY');
      store.run("INSERT INTO mail_drafts VALUES(?,?,'sending',NULL)", args.requestId, digest);
      const raw = Buffer.from([`To: ${args.to.join(',\r\n ')}`, `Subject: ${encodedSubject(args.subject)}`,
        ...replyHeaders, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(args.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''].join('\r\n')).toString('base64url');
      try {
        const result = await googleJson(fetcher, `${mail}/drafts`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw, ...(args.threadId ? { threadId: args.threadId } : {}) } }) }, signal);
        if (typeof result.id !== 'string' || !result.id || (args.threadId && result.message?.threadId !== args.threadId)) throw new Error('MAIL_DRAFT_RESPONSE_INVALID');
        const receipt = { draftId: result.id, threadId: result.message?.threadId ?? args.threadId ?? null };
        store.run("UPDATE mail_drafts SET status='confirmed',result=? WHERE id=?", JSON.stringify(receipt), args.requestId);
        return { status: 'confirmed', ...receipt, requestId: args.requestId };
      } catch {
        store.run("UPDATE mail_drafts SET status='uncertain' WHERE id=?", args.requestId);
        return { status: 'uncertain', requestId: args.requestId, instruction: 'Inspect Gmail drafts manually. Do not create a replacement: the draft may already exist.' };
      }
    },
    draftStatus(input: unknown) { const args = z.strictObject({ requestId }).parse(input); const row = store.get('SELECT id,status,result FROM mail_drafts WHERE id=?', args.requestId); if (!row) throw new Error('MAIL_REQUEST_NOT_FOUND'); return row; },
    async searchDrive(input: unknown, signal?: AbortSignal) {
      const args = driveSearchSchema.parse(input), literal = args.query.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
      const params = new URLSearchParams({ q: `trashed = false and (name contains '${literal}' or fullText contains '${literal}')`, pageSize: '20', fields: 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)', ...(args.pageToken ? { pageToken: args.pageToken } : {}) });
      const result = await get(`https://www.googleapis.com/drive/v3/files?${params}`, signal);
      return { files: result.files ?? [], nextPageToken: result.nextPageToken ?? null, source: 'Google Drive' };
    },
    async readFile(input: unknown, signal?: AbortSignal) {
      const { fileId } = fileSchema.parse(input), base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
      const metadata = await get(`${base}?fields=id,name,mimeType,webViewLink,size`, signal);
      const docs = metadata.mimeType === 'application/vnd.google-apps.document';
      if (!docs && !['text/plain','text/markdown','text/csv'].includes(metadata.mimeType)) throw new Error('DRIVE_TEXT_FORMAT_REQUIRED');
      if (Number(metadata.size ?? 0) > 262144) throw new Error('DRIVE_FILE_TOO_LARGE');
      const response = await fetcher(docs ? `${base}/export?mimeType=text%2Fplain` : `${base}?alt=media`, { headers: await auth(), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('DRIVE_READ_FAILED'); }
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 262144) { await reader.cancel(); throw new Error('DRIVE_FILE_TOO_LARGE'); } parts.push(chunk.value); } } finally { reader.releaseLock(); }
      const content = Buffer.concat(parts).toString('utf8');
      return { ...metadata, text: content.slice(0, 24000), truncated: content.length > 24000 };
    }
  };
}
