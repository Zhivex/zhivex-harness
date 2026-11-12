import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { CalendarStore } from './store.js';
import { createCalendarOAuth } from './oauth.js';
import { googleJson, CalendarHttpError, type CalendarFetch } from './http.js';

const instant = z.string().datetime({ offset: true });
const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);
const time = z.object({ dateTime: instant.optional(), date: z.string().optional(), timeZone: z.string().max(100).optional() });
const eventSchema = z.object({ id: eventId, etag: z.string().min(1).max(256).regex(/^[^\r\n]+$/),
  status: z.string().optional(), summary: z.string().max(1000).default(''), start: time, end: time,
  organizer: z.object({ self: z.boolean().optional(), email: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().max(320), responseStatus: z.string().optional(), self: z.boolean().optional() })).max(200).default([]),
  transparency: z.string().optional(),
  attendeesOmitted: z.boolean().optional(), recurringEventId: z.string().optional(), recurrence: z.array(z.string()).optional(),
  eventType: z.string().optional(), extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional() });
export type CalendarEvent = z.infer<typeof eventSchema>;
export const changeSchema = z.strictObject({ summary: z.string().max(1000), start: instant, end: instant })
  .refine(value => Date.parse(value.start) < Date.parse(value.end), 'End must follow start');
export const proposalSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.string().uuid(),
  connectionId: z.string(), accountId: z.string(), calendarId: z.string(), eventId,
  etag: z.string(), before: z.strictObject({ summary: z.string(), start: instant, end: instant, timeZone: z.string().nullable() }),
  after: changeSchema, notifiedAttendees: z.array(z.string()), sendUpdates: z.literal('all'),
  metadataChange: z.literal('Record private zhivexOperation marker'), createdAt: z.number(), expiresAt: z.number() });
export type CalendarProposal = z.infer<typeof proposalSchema>;
type Operation = { proposal: string; status: string; result: string | null };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',')}}` : JSON.stringify(value);
const modified = (event: CalendarEvent, proposal: CalendarProposal) => event.id === proposal.eventId && event.extendedProperties?.private?.zhivexOperation === proposal.operationId &&
  event.summary === proposal.after.summary && Date.parse(event.start.dateTime ?? '') === Date.parse(proposal.after.start) && Date.parse(event.end.dateTime ?? '') === Date.parse(proposal.after.end);

export function createCalendarService(store: CalendarStore, oauth: ReturnType<typeof createCalendarOAuth>, options: {
  calendarId?: string; fetcher?: CalendarFetch; now?: () => number;
} = {}) {
  const calendarId = options.calendarId ?? 'primary', fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  if (!calendarId || calendarId.length > 320) throw new Error('CALENDAR_ID_INVALID');
  const credentials = oauth.credentials();
  const binding = JSON.stringify({ connectionId: credentials.connectionId, calendarId });
  const request = async (suffix: string, init: RequestInit = {}, signal?: AbortSignal) => {
    const current = await oauth.freshCredentials();
    if (current.connectionId !== credentials.connectionId) throw new Error('CALENDAR_CONNECTION_CHANGED');
    try { return await googleJson(fetcher, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`,
      { ...init, headers: { ...init.headers, authorization: `Bearer ${current.accessToken}` } }, signal); }
    catch (error) { if (error instanceof CalendarHttpError && error.status === 401) store.set('reauthorize', 'yes'); throw error; }
  };
  const read = async (id: string, signal?: AbortSignal) => {
    const expected = eventId.parse(id), event = eventSchema.parse(await request(`/${encodeURIComponent(expected)}`, {}, signal));
    if (event.id !== expected) throw new Error('CALENDAR_EVENT_ID_MISMATCH');
    return event;
  };
  const load = (id: string) => { const row = store.get<Operation>('SELECT proposal,status,result FROM operations WHERE id=?', id);
    if (!row) throw new Error('CALENDAR_OPERATION_UNKNOWN'); const proposal = proposalSchema.parse(JSON.parse(row.proposal));
    if (proposal.connectionId !== credentials.connectionId || proposal.accountId !== credentials.accountId || proposal.calendarId !== calendarId) throw new Error('CALENDAR_CONNECTION_CHANGED');
    return { row, proposal }; };
  const record = (id: string, status: string, extra: Record<string, unknown> = {}) => {
    const result = { operationId: id, status, ...extra };
    const updated = store.run("UPDATE operations SET status=?, result=? WHERE id=? AND status NOT IN ('confirmed','conflict','failed')", status, JSON.stringify(result), id);
    if (Number(updated.changes) !== 1) return JSON.parse(load(id).row.result!);
    return result;
  };
  const reconcile = async (operationId: string, signal?: AbortSignal) => {
    const { row, proposal } = load(z.string().uuid().parse(operationId));
    if (['confirmed','conflict','failed'].includes(row.status)) return JSON.parse(row.result!);
    if (!['dispatching','uncertain'].includes(row.status)) return { operationId, status: row.status };
    try {
      const current = await read(proposal.eventId, signal);
      if (modified(current, proposal)) return record(operationId, 'confirmed', { etag: current.etag, recovered: true, notifications: 'requested_all_not_delivery_verified' });
    } catch { /* A failed GET cannot prove that a PATCH did not happen. */ }
    return record(operationId, 'uncertain', { action: 'No automatic resend. Inspect the event and operation locally.' });
  };
  const reference = (proposal: CalendarProposal) => ({ operationId: proposal.operationId,
    proposalDigest: 'sha256:' + createHash('sha256').update(canonical(proposal)).digest('hex') });
  const reviewReference = (input: unknown) => {
    const parsed = z.strictObject({ operationId: z.string().uuid(), proposalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).parse(input);
    const { row, proposal } = load(parsed.operationId);
    if (reference(proposal).proposalDigest !== parsed.proposalDigest) throw new Error('CALENDAR_PROPOSAL_MISMATCH');
    return { proposal, status: row.status };
  };
  return {
    reference, reviewReference,
    binding, connectionId: credentials.connectionId,
    async list(input: { timeMin: string; timeMax: string; pageToken?: string }, signal?: AbortSignal) {
      const parsed = z.strictObject({ timeMin: instant, timeMax: instant, pageToken: z.string().max(2048).optional() }).parse(input);
      const span = Date.parse(parsed.timeMax) - Date.parse(parsed.timeMin); if (span <= 0 || span > 90 * 86400_000) throw new Error('CALENDAR_RANGE_INVALID');
      const query = new URLSearchParams({ timeMin: parsed.timeMin, timeMax: parsed.timeMax, maxResults: '100', singleEvents: 'true', orderBy: 'startTime', ...(parsed.pageToken ? { pageToken: parsed.pageToken } : {}) });
      const page = await request(`?${query}`, {}, signal);
      if ((page.nextPageToken !== undefined && (typeof page.nextPageToken !== 'string' || !page.nextPageToken || page.nextPageToken.length > 2048)) || !Array.isArray(page.items) || page.items.length > 100) throw new Error('CALENDAR_PAGE_INVALID');
      return { events: page.items.map((raw: unknown) => { const event = eventSchema.parse(raw); return { id: event.id, etag: event.etag, summary: event.summary, start: event.start, end: event.end, status: event.status, busy: event.transparency !== 'transparent' && !event.attendees.some(a => a.self && a.responseStatus === 'declined') }; }),
        nextPageToken: typeof page.nextPageToken === 'string' ? page.nextPageToken : null, complete: !page.nextPageToken };
    },
    read, reconcile,
    async propose(id: string, change: z.infer<typeof changeSchema>, signal?: AbortSignal) {
      const after = changeSchema.parse(change), event = await read(id, signal);
      if (event.status === 'cancelled' || !event.organizer?.self || event.recurrence || event.recurringEventId || event.attendeesOmitted ||
        !event.start.dateTime || !event.end.dateTime || (event.eventType && event.eventType !== 'default')) throw new Error('CALENDAR_EVENT_UNSUPPORTED');
      if (store.get("SELECT id FROM operations WHERE json_extract(proposal,'$.eventId')=? AND json_extract(proposal,'$.connectionId')=? AND status IN ('dispatching','uncertain')", id, credentials.connectionId)) throw new Error('CALENDAR_EVENT_UNCERTAIN_RECONCILE_FIRST');
      const proposal: CalendarProposal = { schemaVersion: 1, operationId: randomUUID(), connectionId: credentials.connectionId,
        accountId: credentials.accountId, calendarId, eventId: event.id, etag: event.etag,
        before: { summary: event.summary, start: event.start.dateTime, end: event.end.dateTime, timeZone: event.start.timeZone ?? null },
        after, notifiedAttendees: event.attendees.map(a => a.email).sort(), sendUpdates: 'all', metadataChange: 'Record private zhivexOperation marker',
        createdAt: now(), expiresAt: now() + 15 * 60_000 };
      store.run("INSERT INTO operations(id,proposal,status) VALUES(?,?,'proposed')", proposal.operationId, canonical(proposal)); return proposal;
    },
    /** Only exposed to the agent through the approval-gated write MCP adapter. */
    async apply(value: unknown, signal?: AbortSignal) {
      const supplied = proposalSchema.parse(value); const { row, proposal } = load(supplied.operationId);
      if (canonical(supplied) !== canonical(proposal)) throw new Error('CALENDAR_PROPOSAL_MISMATCH');
      if (row.status === 'confirmed') return JSON.parse(row.result!);
      if (['dispatching','uncertain'].includes(row.status)) return reconcile(proposal.operationId, signal);
      if (row.status !== 'proposed') throw new Error('CALENDAR_PROPOSAL_NOT_EXECUTABLE');
      if (proposal.expiresAt <= now()) return record(proposal.operationId, 'conflict', { reason: 'proposal_expired' });
      const current = await read(proposal.eventId, signal);
      if (load(proposal.operationId).row.status !== 'proposed') return reconcile(proposal.operationId, signal);
      if (current.etag !== proposal.etag) return record(proposal.operationId, 'conflict', { reason: 'event_changed_new_approval_required' });
      if (signal?.aborted) throw new Error('CALENDAR_CANCELLED');
      // Atomic claim precedes network dispatch. An uncertain claim is never automatically resent.
      let claimed: ReturnType<typeof store.run>;
      try { claimed = store.run("UPDATE operations SET status='dispatching' WHERE id=? AND status='proposed'", proposal.operationId); }
      catch { throw new Error('CALENDAR_OPERATION_CLAIM_FAILED'); }
      if (Number(claimed.changes) !== 1) return reconcile(proposal.operationId, signal);
      try {
        const result = eventSchema.parse(await request(`/${encodeURIComponent(proposal.eventId)}?sendUpdates=all`, {
          method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': proposal.etag },
          body: JSON.stringify({ summary: proposal.after.summary,
            start: { dateTime: proposal.after.start, ...(current.start.timeZone ? { timeZone: current.start.timeZone } : {}) },
            end: { dateTime: proposal.after.end, ...(current.end.timeZone ? { timeZone: current.end.timeZone } : {}) },
            extendedProperties: { private: { ...current.extendedProperties?.private, zhivexOperation: proposal.operationId } } })
        }, signal));
        if (!modified(result, proposal)) return record(proposal.operationId, 'uncertain');
        return record(proposal.operationId, 'confirmed', { etag: result.etag, notifications: 'requested_all_not_delivery_verified' });
      } catch (error) {
        if (error instanceof CalendarHttpError && error.status === 412) return record(proposal.operationId, 'conflict', { reason: 'event_changed_new_approval_required' });
        if (error instanceof CalendarHttpError && [400,401,403,404,429].includes(error.status)) return record(proposal.operationId, 'failed', { reason: error.message });
        record(proposal.operationId, 'uncertain'); return reconcile(proposal.operationId, signal);
      }
    }
  };
}
