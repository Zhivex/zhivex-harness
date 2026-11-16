import {test, expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {attachCalendarChange} from '../packages/core/src/application/calendar-review.js';
import {ReviewTickets} from '../packages/core/src/application/review-tickets.js';
import type {ApprovalReviewItem} from '../packages/core/src/application/approval-review.js';
const item = (): ApprovalReviewItem => ({approvalId: 'approval', digest: 'a'.repeat(64), expiresAt: Date.now() + 600000, name: 'calendar_write_apply', payloadDigest: 'sha256:' + 'b'.repeat(64), payload: '{}', files: [], commands: [], consequence: '', complete: true});
const proposal = () => ({schemaVersion: 1, operationId: randomUUID(), connectionId: 'connection', accountId: 'account', calendarId: 'primary', eventId: 'event', etag: 'v1', before: {summary: '<script>before</script>', start: '2026-11-14T10:00:00-03:00', end: '2026-11-14T11:00:00-03:00', timeZone: 'America/Argentina/Buenos_Aires'}, after: {summary: 'After', start: '2026-11-14T15:00:00Z', end: '2026-11-14T16:00:00Z'}, notifiedAttendees: ['guest@example.test'], sendUpdates: 'all', metadataChange: 'Record private zhivexOperation marker', createdAt: Date.now(), expiresAt: Date.now() + 60000});

test('calendar review projects exact stored changes and the ticket expires with the proposal', () => {
  const value = item(), stored = proposal();
  attachCalendarChange(value, {proposal: stored, status: 'proposed'});
  expect(value.complete).toBe(true); expect(value.expiresAt).toBe(stored.expiresAt);
  expect(value.calendarChange).toMatchObject({before: {summary: stored.before.summary, start: stored.before.start}, after: stored.after, attendees: stored.notifiedAttendees, sendUpdates: 'all'});
  const tickets = new ReviewTickets(['calendar_write_apply']);
  const review = tickets.issue('session', {schemaVersion: 1, runId: 'run', revision: 1, status: 'waiting_approval', items: [value]});
  expect(review.canApprove).toBe(true);
  expect(() => tickets.consume(review.ticketId, true, stored.expiresAt)).toThrow('REVIEW_EXPIRED');
});
test('already dispatched, uncertain or malformed calendar proposals cannot produce approvable previews', () => {
  for (const status of ['dispatching', 'uncertain', 'confirmed', 'failed', 'conflict']) {
    const value = item(); attachCalendarChange(value, {proposal: proposal(), status});
    expect(value.complete).toBe(false); expect(value.calendarChange).toBeUndefined();
  }
  const value = item(); attachCalendarChange(value, {proposal: {...proposal(), after: {summary: 'bad', start: 'invalid', end: 'invalid'}}, status: 'proposed'});
  expect(value.complete).toBe(false);
});
