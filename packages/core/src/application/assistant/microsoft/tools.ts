import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requestId } from '../daily/service.js';
import { microsoftJson, microsoftScopes, type MicrosoftOptions, type openMicrosoftConnection } from './connection.js';

const id = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_=+\/-]+$/);
export const mailListSchema = z.strictObject({ query: z.string().trim().min(1).max(300).optional(), unreadOnly: z.boolean().default(false), pageToken: z.string().max(8192).optional() });
export const mailReadSchema = z.strictObject({ messageId: id });
export const outlookDraftSchema = z.strictObject({ requestId, to: z.array(z.email().max(254)).min(1).max(20), cc: z.array(z.email().max(254)).max(20).default([]), subject: z.string().min(1).max(500).regex(/^[^\r\n\x00]+$/), body: z.string().max(16000) });
const instant = z.iso.datetime({ offset: true });
export const calendarListSchema = z.strictObject({ timeMin: instant, timeMax: instant, pageToken: z.string().max(8192).optional() }).refine(v => Date.parse(v.timeMax) > Date.parse(v.timeMin) && Date.parse(v.timeMax) - Date.parse(v.timeMin) <= 366 * 86400000, 'Choose a range of up to 366 days.');
export const eventCreateSchema = z.strictObject({ requestId, subject: z.string().min(1).max(500), body: z.string().max(16000).default(''), start: instant, end: instant, location: z.string().max(500).default('') }).refine(v => Date.parse(v.end) > Date.parse(v.start), 'End must follow start.');
export const proposalReferenceSchema = z.strictObject({ requestId, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export const operationSchema = z.strictObject({ requestId });
const graph = 'https://graph.microsoft.com/v1.0';
export function createMicrosoftTools(connection: Awaited<ReturnType<typeof openMicrosoftConnection>>, options: MicrosoftOptions) {
  const { store, oauth } = connection, identity = oauth.credentials(), fetcher = options.fetcher ?? fetch;
  const binding = createHash('sha256').update(JSON.stringify({ accountId: identity.accountId, connectionId: identity.connectionId, tenantId: identity.tenantId, scopes: microsoftScopes(options) })).digest('hex');
  store.run('CREATE TABLE IF NOT EXISTS microsoft_operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT)');
  store.run("UPDATE microsoft_operations SET status='uncertain' WHERE status='dispatching'");
  const headers = async () => {
    const current = await oauth.freshCredentials();
    if (current.accountId !== identity.accountId || current.connectionId !== identity.connectionId) throw new Error('MICROSOFT_CONNECTION_CHANGED');
    return { authorization: `Bearer ${current.accessToken}`, prefer: 'outlook.body-content-type="text", outlook.timezone="UTC"' };
  };
  const requireMail = () => { if (!options.mail) throw new Error('MICROSOFT_MAIL_DISABLED'); };
  const requireCalendar = () => { if (!options.calendar) throw new Error('MICROSOFT_CALENDAR_DISABLED'); };
  // Persist opaque continuation URLs so model-supplied input can never redirect credentials.
  const pageUrl = (token: string | undefined, kind: string, query: string, fallback: string) => {
    if (!token) return fallback;
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('MICROSOFT_PAGE_INVALID');
    const page = store.decrypt<{ kind: string; query: string; url: string }>(`page:${token}`);
    if (!page || page.kind !== kind || page.query !== query) throw new Error('MICROSOFT_PAGE_INVALID');
    return page.url;
  };
  const continuation = (url: unknown, kind: string, query: string, pathname: string) => {
    if (url === undefined) return null;
    if (typeof url !== 'string' || url.length > 8192) throw new Error('MICROSOFT_PAGE_INVALID');
    const parsed = new URL(url);
    if (parsed.origin !== 'https://graph.microsoft.com' || parsed.pathname !== pathname || parsed.username || parsed.password || parsed.hash) throw new Error('MICROSOFT_PAGE_INVALID');
    const token = createHash('sha256').update(kind + query + url).digest('hex');
    if (store.get<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'page:%'")!.n >= 2000) store.run("DELETE FROM meta WHERE key LIKE 'page:%'");
    store.encrypt(`page:${token}`, { kind, query, url }); return token;
  };
  const write = async (kind: string, args: { requestId: string }, url: string, body: unknown, signal?: AbortSignal) => {
    const digest = createHash('sha256').update(JSON.stringify({ binding, kind, args })).digest('hex');
    const prior = store.get<{ digest: string; status: string; result: string | null }>('SELECT * FROM microsoft_operations WHERE id=?', args.requestId);
    if (prior) { if (prior.digest !== digest) throw new Error('MICROSOFT_REQUEST_CONFLICT'); return { requestId: args.requestId, status: prior.status, ...(prior.result ? JSON.parse(prior.result) : {}) }; }
    const auth = await headers(); signal?.throwIfAborted();
    // Concurrent callers can refresh credentials together; reserve only after the final await.
    const competing = store.get('SELECT id FROM microsoft_operations WHERE id=?', args.requestId);
    if (competing) throw new Error('MICROSOFT_REQUEST_IN_PROGRESS');
    if (store.get<{ n: number }>('SELECT COUNT(*) n FROM microsoft_operations')!.n >= 10000) throw new Error('MICROSOFT_OPERATION_CAPACITY');
    store.run("INSERT INTO microsoft_operations VALUES(?,?,'dispatching',NULL)", args.requestId, digest);
    try {
      const result = await microsoftJson(fetcher, url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal);
      if (typeof result.id !== 'string' || !result.id || (kind === 'draft' && result.isDraft !== true)) throw new Error('MICROSOFT_RESPONSE_INVALID');
      const receipt = { id: result.id, webLink: result.webLink ?? null, kind };
      store.run("UPDATE microsoft_operations SET status='confirmed',result=? WHERE id=?", JSON.stringify(receipt), args.requestId);
      return { requestId: args.requestId, status: 'confirmed', ...receipt };
    } catch {
      store.run("UPDATE microsoft_operations SET status='uncertain' WHERE id=?", args.requestId);
      return { requestId: args.requestId, status: 'uncertain', instruction: 'Check Outlook manually. Do not create a replacement or use a new requestId; the operation may already have succeeded.' };
    }
  };
  type Proposal = { kind: 'draft' | 'event'; args: unknown; binding: string; expiresAt: number; proposalDigest: string };
  const propose = (kind: Proposal['kind'], input: unknown) => {
    if (kind === 'draft') requireMail(); else requireCalendar();
    const args = kind === 'draft' ? outlookDraftSchema.parse(input) : eventCreateSchema.parse(input);
    const key = `proposal:${args.requestId}`, existing = store.decrypt<Proposal>(key);
    const payload = { kind, args, binding };
    if (existing) {
      if (JSON.stringify({ kind: existing.kind, args: existing.args, binding: existing.binding }) !== JSON.stringify(payload)) throw new Error('MICROSOFT_REQUEST_CONFLICT');
      return { requestId: args.requestId, proposalDigest: existing.proposalDigest };
    }
    if (store.get<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'proposal:%'")!.n >= 10000) throw new Error('MICROSOFT_OPERATION_CAPACITY');
    const expiresAt = (options.now ?? Date.now)() + 15 * 60_000;
    const proposalDigest = createHash('sha256').update(JSON.stringify({ ...payload, expiresAt })).digest('hex');
    store.encrypt(key, { ...payload, expiresAt, proposalDigest }); return { requestId: args.requestId, proposalDigest };
  };
  const review = (input: unknown) => {
    const reference = proposalReferenceSchema.parse(input), proposal = store.decrypt<Proposal>(`proposal:${reference.requestId}`);
    if (!proposal || proposal.binding !== binding || proposal.proposalDigest !== reference.proposalDigest) throw new Error('MICROSOFT_PROPOSAL_INVALID');
    if (proposal.expiresAt < (options.now ?? Date.now)()) throw new Error('MICROSOFT_PROPOSAL_EXPIRED');
    return { ...proposal, account: identity.email };
  };
  const service = {
    binding,
    proposeDraft: (input: unknown) => propose('draft', input),
    proposeEvent: (input: unknown) => propose('event', input),
    review,
    apply(input: unknown, signal?: AbortSignal): Promise<unknown> {
      const proposal = review(input);
      return proposal.kind === 'draft' ? service.createDraft(proposal.args, signal) : service.createEvent(proposal.args, signal);
    },
    async readReplyThread(threadId: string, signal: AbortSignal) {
      requireMail(); id.parse(threadId);
      const query = JSON.stringify({ threadId });
      const params = new URLSearchParams({ '$top': '100', '$select': 'id,conversationId,from,receivedDateTime,isDraft', '$filter': `conversationId eq '${threadId}'` });
      let url = `${graph}/me/messages?${params}`;
      const messages: { id: string; from: string; at: number; draft: boolean }[] = [], seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        if (seen.has(url)) throw new Error('PROACTIVE_THREAD_INCOMPLETE'); seen.add(url);
        const result = await microsoftJson(fetcher, url, { headers: await headers() }, signal);
        if (!Array.isArray(result.value) || result.value.length > 100) throw new Error('PROACTIVE_THREAD_INCOMPLETE');
        for (const m of result.value) {
          const at = Date.parse(m.receivedDateTime);
          if (m.conversationId !== threadId || typeof m.id !== 'string' || typeof m.from?.emailAddress?.address !== 'string' || !Number.isFinite(at) || typeof m.isDraft !== 'boolean') throw new Error('PROACTIVE_THREAD_INVALID');
          messages.push({ id: m.id, from: m.from.emailAddress.address, at, draft: m.isDraft });
        }
        const token = continuation(result['@odata.nextLink'], 'reply', query, '/v1.0/me/messages');
        if (!token) return { complete: true, messages };
        url = pageUrl(token, 'reply', query, url);
      }
      throw new Error('PROACTIVE_THREAD_INCOMPLETE');
    },
    async listMail(input: unknown, signal?: AbortSignal) {
      requireMail(); const args = mailListSchema.parse(input);
      if (args.query && args.unreadOnly) throw new Error('MICROSOFT_SEARCH_FILTER_UNSUPPORTED');
      const query = JSON.stringify({ query: args.query, unreadOnly: args.unreadOnly });
      const params = new URLSearchParams({ '$top': '20', '$select': 'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,webLink,conversationId' });
      if (args.query) params.set('$search', JSON.stringify(args.query));
      else { params.set('$orderby', 'receivedDateTime desc'); if (args.unreadOnly) params.set('$filter', 'isRead eq false'); }
      const result = await microsoftJson(fetcher, pageUrl(args.pageToken, 'mail', query, `${graph}/me/messages?${params}`), { headers: await headers() }, signal);
      if (!Array.isArray(result.value)) throw new Error('MICROSOFT_RESPONSE_INVALID');
      return { messages: result.value, nextPageToken: continuation(result['@odata.nextLink'], 'mail', query, '/v1.0/me/messages') };
    },
    async readMail(input: unknown, signal?: AbortSignal) {
      requireMail(); const args = mailReadSchema.parse(input);
      const result = await microsoftJson(fetcher, `${graph}/me/messages/${encodeURIComponent(args.messageId)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink,conversationId,isDraft,hasAttachments`, { headers: await headers() }, signal);
      const text = String(result.body?.content ?? '');
      return { ...result, body: { contentType: result.body?.contentType, content: text.slice(0, 24000) }, truncated: text.length > 24000, attachmentsLoaded: false };
    },
    createDraft(input: unknown, signal?: AbortSignal) {
      requireMail(); const args = outlookDraftSchema.parse(input);
      const recipients = (addresses: string[]) => addresses.map(address => ({ emailAddress: { address } }));
      return write('draft', args, `${graph}/me/messages`, { subject: args.subject, body: { contentType: 'Text', content: args.body }, toRecipients: recipients(args.to), ccRecipients: recipients(args.cc) }, signal);
    },
    async listEvents(input: unknown, signal?: AbortSignal) {
      requireCalendar(); const args = calendarListSchema.parse(input), query = JSON.stringify({ timeMin: args.timeMin, timeMax: args.timeMax });
      const params = new URLSearchParams({ startDateTime: args.timeMin, endDateTime: args.timeMax, '$top': '100', '$select': 'id,subject,start,end,isAllDay,isCancelled,showAs,webLink,location', '$orderby': 'start/dateTime' });
      const result = await microsoftJson(fetcher, pageUrl(args.pageToken, 'calendar', query, `${graph}/me/calendarView?${params}`), { headers: await headers() }, signal);
      if (!Array.isArray(result.value)) throw new Error('MICROSOFT_RESPONSE_INVALID');
      const utc = (v: any) => { if (!v || v.timeZone !== 'UTC' || typeof v.dateTime !== 'string') throw new Error('MICROSOFT_TIMEZONE_INVALID'); return /Z$/.test(v.dateTime) ? v.dateTime : `${v.dateTime}Z`; };
      return { events: result.value.map((v: any) => ({ id: v.id, summary: v.subject, status: v.isCancelled ? 'cancelled' : 'confirmed', busy: v.showAs !== 'free', start: { dateTime: utc(v.start) }, end: { dateTime: utc(v.end) }, webLink: v.webLink, isAllDay: v.isAllDay })), nextPageToken: continuation(result['@odata.nextLink'], 'calendar', query, '/v1.0/me/calendarView') };
    },
    createEvent(input: unknown, signal?: AbortSignal) {
      requireCalendar(); const args = eventCreateSchema.parse(input), utc = (v: string) => ({ dateTime: new Date(v).toISOString().replace(/Z$/, ''), timeZone: 'UTC' });
      return write('event', args, `${graph}/me/events`, { subject: args.subject, body: { contentType: 'Text', content: args.body }, start: utc(args.start), end: utc(args.end), location: { displayName: args.location }, transactionId: args.requestId }, signal);
    },
    operationStatus(input: unknown) {
      const args = operationSchema.parse(input), row = store.get<{ status: string; result: string | null }>('SELECT status,result FROM microsoft_operations WHERE id=?', args.requestId);
      if (!row) throw new Error('MICROSOFT_REQUEST_NOT_FOUND');
      return { requestId: args.requestId, status: row.status, ...(row.result ? JSON.parse(row.result) : {}) };
    }
  };
  return service;
}
