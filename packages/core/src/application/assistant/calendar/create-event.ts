import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CalendarStore} from './store.js';
import {CalendarHttpError} from './http.js';
const instant = z.string().datetime({offset: true});
const eventFields = {
  summary: z.string().trim().min(1).max(1000), start: instant, end: instant,
  attendees: z.array(z.string().email().max(320).transform(value => value.toLowerCase())).max(100).transform(values => [...new Set(values)].sort()),
};
export const createEventInputSchema = z.strictObject({requestId: z.string().uuid(), ...eventFields}).refine(value => Date.parse(value.end) > Date.parse(value.start), 'End must follow start');
export const createEventProposalSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('create'), operationId: z.string().uuid(), eventId: z.string().regex(/^[0-9a-f]{32}$/),
  connectionId: z.string(), accountId: z.string(), calendarId: z.string(),
  ...eventFields, sendUpdates: z.literal('all'), createdAt: z.number(), expiresAt: z.number(),
}).refine(value => Date.parse(value.end) > Date.parse(value.start), 'End must follow start');
type Proposal = z.infer<typeof createEventProposalSchema>;
type Row = {proposal: string; input_digest: string; status: string; result: string | null};
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const referenceSchema = z.strictObject({operationId: z.string().uuid(), proposalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)});
const createdEventSchema = z.object({id: z.string(), etag: z.string(), summary: z.string(), status: z.string().optional(),
  start: z.object({dateTime: instant}), end: z.object({dateTime: instant}), attendeesOmitted: z.boolean().optional(),
  attendees: z.array(z.object({email: z.string()})).max(200).default([]),
  extendedProperties: z.object({private: z.record(z.string(), z.string()).optional()}).optional()});

/** Durable creation state machine. The caller must obtain human approval before apply. */
export function createCalendarCreation(store: CalendarStore, binding: {connectionId: string; accountId: string; calendarId: string},
  request: (suffix: string, init?: RequestInit, signal?: AbortSignal) => Promise<unknown>, now = Date.now) {
  const load = (id: string) => {
    const row = store.get<Row>('SELECT proposal,input_digest,status,result FROM create_operations WHERE id=?', z.string().uuid().parse(id));
    if (!row) throw new Error('CALENDAR_CREATE_OPERATION_UNKNOWN');
    const proposal = createEventProposalSchema.parse(JSON.parse(row.proposal));
    if (proposal.connectionId !== binding.connectionId || proposal.accountId !== binding.accountId || proposal.calendarId !== binding.calendarId) throw new Error('CALENDAR_CONNECTION_CHANGED');
    return {row, proposal};
  };
  const reference = (proposal: Proposal) => ({operationId: proposal.operationId, proposalDigest: digest(createEventProposalSchema.parse(proposal))});
  const reviewReference = (raw: unknown) => {
    const value = referenceSchema.parse(raw), {row, proposal} = load(value.operationId);
    if (reference(proposal).proposalDigest !== value.proposalDigest) throw new Error('CALENDAR_PROPOSAL_MISMATCH');
    return {proposal, status: row.status};
  };
  const matches = (raw: unknown, proposal: Proposal) => {
    const result = createdEventSchema.safeParse(raw); if (!result.success) return false;
    const event = result.data;
    return event.id === proposal.eventId && event.status !== 'cancelled' && !event.attendeesOmitted &&
      event.extendedProperties?.private?.zhivexOperation === proposal.operationId && event.summary === proposal.summary &&
      Date.parse(event.start.dateTime) === Date.parse(proposal.start) && Date.parse(event.end.dateTime) === Date.parse(proposal.end) &&
      JSON.stringify([...new Set(event.attendees.map(item => item.email.toLowerCase()))].sort()) === JSON.stringify(proposal.attendees);
  };
  const record = (id: string, status: string, extra: Record<string, unknown> = {}) => {
    const result = {operationId: id, status, ...extra};
    const changed = store.run("UPDATE create_operations SET status=?,result=? WHERE id=? AND status NOT IN ('confirmed','conflict','failed')", status, JSON.stringify(result), id);
    return Number(changed.changes) === 1 ? result : JSON.parse(load(id).row.result!);
  };
  const reconcile = async (id: string, signal?: AbortSignal) => {
    const {row, proposal} = load(id);
    if (['confirmed','conflict','failed'].includes(row.status)) return JSON.parse(row.result!);
    if (!['dispatching','uncertain'].includes(row.status)) return {operationId: id, status: row.status};
    try {
      const event = await request('/' + proposal.eventId, {}, signal);
      if (matches(event, proposal)) return record(id, 'confirmed', {eventId: proposal.eventId, recovered: true, notifications: 'requested_all_not_delivery_verified'});
    } catch { /* Neither absence nor a read failure proves a POST was not accepted. */ }
    return record(id, 'uncertain', {eventId: proposal.eventId, action: 'Inspect this event and operation. No automatic resend.'});
  };
  const propose = (raw: unknown) => {
    const input = createEventInputSchema.parse(raw), inputDigest = digest(input);
    const existing = store.get<Row>('SELECT proposal,input_digest,status,result FROM create_operations WHERE id=?', input.requestId);
    if (existing) {const loaded = load(input.requestId); if (existing.input_digest !== inputDigest) throw new Error('CALENDAR_CREATE_REQUEST_REUSED'); return loaded.proposal;}
    const proposal = createEventProposalSchema.parse({schemaVersion: 1, kind: 'create', operationId: input.requestId, eventId: input.requestId.replaceAll('-', ''), ...binding,
      summary: input.summary, start: input.start, end: input.end, attendees: input.attendees, sendUpdates: 'all', createdAt: now(), expiresAt: now() + 15 * 60000});
    store.run("INSERT INTO create_operations(id,proposal,input_digest,status) VALUES(?,?,?,'proposed')", proposal.operationId, JSON.stringify(proposal), inputDigest);
    return proposal;
  };
  const apply = async (raw: unknown, signal?: AbortSignal) => {
    const {proposal} = reviewReference(raw), {row} = load(proposal.operationId);
    if (['confirmed','conflict','failed'].includes(row.status)) return JSON.parse(row.result!);
    if (['dispatching','uncertain'].includes(row.status)) return reconcile(proposal.operationId, signal);
    if (row.status !== 'proposed') throw new Error('CALENDAR_PROPOSAL_NOT_EXECUTABLE');
    if (proposal.expiresAt <= now()) return record(proposal.operationId, 'conflict', {reason: 'proposal_expired'});
    signal?.throwIfAborted();
    const claimed = store.run("UPDATE create_operations SET status='dispatching' WHERE id=? AND status='proposed'", proposal.operationId);
    if (Number(claimed.changes) !== 1) return reconcile(proposal.operationId, signal);
    try {
      const event = await request('?sendUpdates=all', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
        id: proposal.eventId, summary: proposal.summary, start: {dateTime: proposal.start}, end: {dateTime: proposal.end},
        attendees: proposal.attendees.map(email => ({email})), extendedProperties: {private: {zhivexOperation: proposal.operationId}},
      })}, signal);
      if (matches(event, proposal)) return record(proposal.operationId, 'confirmed', {eventId: proposal.eventId, notifications: 'requested_all_not_delivery_verified'});
    } catch (error) {
      if (error instanceof CalendarHttpError && [400,401,403,404,429].includes(error.status)) return record(proposal.operationId, 'failed', {reason: error.message});
    }
    record(proposal.operationId, 'uncertain');
    return reconcile(proposal.operationId, signal);
  };
  return {propose, reference, reviewReference, apply, reconcile};
}
