import {createEventProposalSchema} from './assistant/calendar/create-event.js';
import {z} from 'zod';
import {proposalSchema} from './assistant/calendar/calendar.js';
import type {ApprovalReviewItem} from './approval-review.js';
const detailsSchema = z.object({proposal: proposalSchema, status: z.literal('proposed')});
/** Called only after the complete stored details pass the host's credential-redaction gate. */
export function attachCalendarChange(item: ApprovalReviewItem, details: unknown) {
  const result = detailsSchema.safeParse(details);
  if (!result.success) {item.complete = false; item.restriction = 'BASE_UNAVAILABLE'; return;}
  const {proposal} = result.data;
  item.expiresAt = Math.min(item.expiresAt, proposal.expiresAt);
  item.calendarChange = {
    calendarId: proposal.calendarId, accountId: proposal.accountId,
    before: {summary: proposal.before.summary, start: proposal.before.start, end: proposal.before.end},
    after: {...proposal.after}, attendees: [...proposal.notifiedAttendees], sendUpdates: proposal.sendUpdates,
  };
  item.consequence = 'Changes the displayed event and requests notifications to all listed attendees. Notification delivery is not verified.';
}

/** New-event projection uses the same credential-redaction prerequisite as changes. */
export function attachCalendarCreation(item: ApprovalReviewItem, details: unknown) {
  const result = z.object({proposal: createEventProposalSchema, status: z.literal('proposed')}).safeParse(details);
  if (!result.success) {item.complete = false; item.restriction = 'BASE_UNAVAILABLE'; return;}
  const {proposal} = result.data;
  item.expiresAt = Math.min(item.expiresAt, proposal.expiresAt);
  item.calendarCreation = {calendarId: proposal.calendarId, accountId: proposal.accountId, after: {summary: proposal.summary, start: proposal.start, end: proposal.end}, attendees: [...proposal.attendees], sendUpdates: proposal.sendUpdates};
  item.consequence = 'Creates the displayed event and requests notifications to all listed attendees. Notification delivery is not verified.';
}
