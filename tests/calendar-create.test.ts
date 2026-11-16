import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {openCalendarStore} from '../packages/core/src/application/assistant/calendar/store.js';
import {createCalendarCreation} from '../packages/core/src/application/assistant/calendar/create-event.js';
import {CalendarHttpError} from '../packages/core/src/application/assistant/calendar/http.js';
const binding = {connectionId: 'connection', accountId: 'account', calendarId: 'primary'};
const input = () => ({requestId: randomUUID(), summary: 'New event', start: '2026-11-14T12:00:00Z', end: '2026-11-14T13:00:00Z', attendees: ['guest@example.test']});
async function fixture() {
  const directory = await mkdtemp('/tmp/zhx-create-event-'), key = randomBytes(32).toString('base64');
  let store = await openCalendarStore(directory, key), now = Date.now(), posts = 0, mode = 'ok';
  let event: any;
  const request = async (_suffix: string, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      posts++; expect(_suffix).toBe('?sendUpdates=all');
      if (mode === 'lost-before') throw new Error('lost response');
      if (mode === 'denied') throw new CalendarHttpError(403);
      if (mode === 'collision') throw new CalendarHttpError(409);
      event = {...JSON.parse(String(init.body)), etag: 'v1', status: 'confirmed'};
      if (mode === 'lost-after') throw new Error('lost response');
      if (mode === 'mismatch') event.summary = 'Changed elsewhere';
      return event;
    }
    if (!event) throw new CalendarHttpError(404);
    return event;
  };
  let service = createCalendarCreation(store, binding, request, () => now);
  return {get service() {return service;}, get store() {return store;}, get posts() {return posts;}, get event() {return event;}, setEvent(value: unknown) {event = value;}, setMode(value: string) {mode = value;}, advance() {now += 16 * 60000;},
    async restart() {await store.close(); store = await openCalendarStore(directory, key); service = createCalendarCreation(store, binding, request, () => now);},
    async close() {await store.close(); await rm(directory, {recursive: true, force: true});}};
}
test('creation proposal is durable, exact and inert; applying its reference creates once', async () => {
  const f = await fixture(); try {
    const raw = input(), proposal = f.service.propose(raw), ref = f.service.reference(proposal);
    expect(proposal.eventId).toMatch(/^[0-9a-f]{32}$/); expect(f.posts).toBe(0);
    expect(f.service.propose(raw)).toEqual(proposal);
    expect(() => f.service.propose({...raw, summary: 'Different request'})).toThrow('CALENDAR_CREATE_REQUEST_REUSED');
    await expect(f.service.apply({...ref, proposalDigest: 'sha256:' + 'a'.repeat(64)})).rejects.toThrow('CALENDAR_PROPOSAL_MISMATCH');
    expect(f.posts).toBe(0); await f.restart(); expect(f.service.reviewReference(ref).proposal).toEqual(proposal);
    expect(await f.service.apply(ref)).toMatchObject({status: 'confirmed', eventId: proposal.eventId});
    expect(f.event.attendees).toEqual([{email: 'guest@example.test'}]); expect(f.event.extendedProperties.private.zhivexOperation).toBe(proposal.operationId);
    expect(await f.service.apply(ref)).toMatchObject({status: 'confirmed'}); expect(f.posts).toBe(1);
  } finally {await f.close();}
});
for (const mode of ['lost-before', 'lost-after', 'collision', 'mismatch']) test(`creation ${mode} reconciles without a second POST, including restart`, async () => {
  const f = await fixture(); try {
    f.setMode(mode); const ref = f.service.reference(f.service.propose(input()));
    const expected = mode === 'lost-after' ? 'confirmed' : 'uncertain';
    expect(await f.service.apply(ref)).toMatchObject({status: expected}); expect(f.posts).toBe(1);
    await f.restart(); expect(await f.service.apply(ref)).toMatchObject({status: expected});
    expect(await f.service.reconcile(ref.operationId)).toMatchObject({status: expected}); expect(f.posts).toBe(1);
  } finally {await f.close();}
});
test('restart of a claimed creation never dispatches again and cannot confirm a foreign event', async () => {
  const f = await fixture(); try {
    const proposal = f.service.propose(input()), ref = f.service.reference(proposal);
    f.store.run("UPDATE create_operations SET status='dispatching' WHERE id=?", proposal.operationId);
    await f.restart(); expect(f.service.reviewReference(ref).status).toBe('uncertain');
    f.setEvent({id: proposal.eventId, etag: 'v1', summary: proposal.summary, start: {dateTime: proposal.start}, end: {dateTime: proposal.end}, attendees: proposal.attendees.map(email => ({email})), extendedProperties: {private: {zhivexOperation: randomUUID()}}});
    expect(await f.service.apply(ref)).toMatchObject({status: 'uncertain'}); expect(f.posts).toBe(0);
    f.setEvent({...f.event, extendedProperties: {private: {zhivexOperation: proposal.operationId}}});
    expect(await f.service.reconcile(proposal.operationId)).toMatchObject({status: 'confirmed'}); expect(f.posts).toBe(0);
  } finally {await f.close();}
});
test('expired, cancelled, denied and wrong-account creation paths preserve authority', async () => {
  const f = await fixture(); try {
    const ref = f.service.reference(f.service.propose(input()));
    await expect(f.service.apply(ref, AbortSignal.abort())).rejects.toThrow(); expect(f.posts).toBe(0);
    const other = createCalendarCreation(f.store, {...binding, accountId: 'other'}, async () => {throw new Error('must not request');});
    expect(() => other.reviewReference(ref)).toThrow('CALENDAR_CONNECTION_CHANGED');
    f.advance(); expect(await f.service.apply(ref)).toMatchObject({status: 'conflict'}); expect(f.posts).toBe(0);
    const next = f.service.reference(f.service.propose(input())); f.setMode('denied');
    expect(await f.service.apply(next)).toMatchObject({status: 'failed'}); expect(await f.service.apply(next)).toMatchObject({status: 'failed'}); expect(f.posts).toBe(1);
  } finally {await f.close();}
});
test('concurrent application of the same creation claims one POST', async () => {
  const f = await fixture(); try {
    const ref = f.service.reference(f.service.propose(input()));
    const results = await Promise.all([f.service.apply(ref), f.service.apply(ref)]);
    expect(results.every(value => value.status === 'confirmed')).toBe(true); expect(f.posts).toBe(1);
  } finally {await f.close();}
});
