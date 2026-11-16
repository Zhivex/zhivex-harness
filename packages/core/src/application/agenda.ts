import type {AgendaSnapshot} from './contracts.js';
export type {AgendaSnapshot} from './contracts.js';
import {createEventInputSchema} from './assistant/calendar/create-event.js';
import {z} from 'zod';
import {connectApplication} from './client.js';
import type {ManagedApplication} from './coordinator-client.js';
import {dayWindow, validZone} from './assistant/automation/time.js';
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value);
const timeSchema = z.object({date: dateSchema.optional(), dateTime: z.string().refine(value => /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))).optional()}).refine(value => Boolean(value.date) !== Boolean(value.dateTime));
const eventSchema = z.object({id: z.string().min(1), summary: z.string().max(16000), status: z.string().optional(), busy: z.boolean().optional(), start: timeSchema, end: timeSchema}).refine(value => Boolean(value.start.date) === Boolean(value.end.date) && Date.parse(value.end.dateTime ?? value.end.date!) > Date.parse(value.start.dateTime ?? value.start.date!));
/** Read-only projection. Network reads never serialize configuration changes or authorize event writes. */
export async function readApplicationAgenda(manager: ManagedApplication, raw: unknown, cancellation?: AbortSignal): Promise<AgendaSnapshot> {
  const input = z.object({projectId: z.string().min(1), date: dateSchema, timeZone: z.string().refine(validZone)}).strict().parse(raw);
  const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
  if ((await connectApplication(host.credentialsPath)).projectId !== input.projectId) throw new Error('APPLICATION_SCOPE_CHANGED');
  const base = {date: input.date, timeZone: input.timeZone};
  if (!host.agendaSource) return {...base, connected: false, complete: true, events: []};
  const window = dayWindow(input.date, input.timeZone); if (!window) throw new Error('AGENDA_DAY_MISSING');
  const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(cancellation ? [cancellation] : [])]);
  const events = new Map<string, z.infer<typeof eventSchema>>(), seen = new Set<string>(); let pageToken: string | undefined, complete = false;
  for (let page = 0; page < 10; page++) {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {abort = () => reject(new Error('AGENDA_READ_CANCELLED')); signal.addEventListener('abort', abort, {once: true});});
    let result;
    try {result = await Promise.race([host.agendaSource.list({timeMin: new Date(window.start).toISOString(), timeMax: new Date(window.end).toISOString(), ...(pageToken ? {pageToken} : {})}, signal), cancelled]);}
    finally {signal.removeEventListener('abort', abort);}
    if (manager.currentHost() !== host) throw new Error('APPLICATION_SCOPE_CHANGED');
    if (!Array.isArray(result.events) || result.events.length > 100) throw new Error('AGENDA_PAGE_INVALID');
    for (const event of z.array(eventSchema).parse(result.events)) events.set(event.id, event);
    if (result.complete && !result.nextPageToken) {complete = true; break;}
    if (!result.nextPageToken || seen.has(result.nextPageToken)) break;
    if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 2048) throw new Error('AGENDA_PAGE_INVALID');
    seen.add(result.nextPageToken); pageToken = result.nextPageToken;
  }
  return {...base, connected: true, ...(host.agendaSource.canCreate ? {canCreate: true} : {}), complete, calendarId: host.agendaSource.calendarId, events: [...events.values()].sort((a, b) => Number(Boolean(b.start.date)) - Number(Boolean(a.start.date)) || Date.parse(a.start.dateTime ?? a.start.date!) - Date.parse(b.start.dateTime ?? b.start.date!) || a.id.localeCompare(b.id))};
}

/** Local proposal preparation only. External creation remains an approval-gated tool. */
export async function prepareApplicationCalendarCreation(manager: ManagedApplication, raw: unknown) {
  const input = z.strictObject({projectId: z.string().min(1), event: createEventInputSchema}).parse(raw);
  const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
  if ((await connectApplication(host.credentialsPath)).projectId !== input.projectId || manager.currentHost() !== host) throw new Error('APPLICATION_SCOPE_CHANGED');
  if (!host.prepareCalendarCreation) throw new Error('CALENDAR_CREATION_DISABLED');
  return host.prepareCalendarCreation(input.event);
}
