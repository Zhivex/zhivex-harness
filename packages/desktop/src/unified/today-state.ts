import type {AgendaSnapshot} from '@zhivex-ai/harness/application/protocol';

export function localAgendaDate(timeZone: string, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
/** Calendar arithmetic, independent of DST and the process time zone. */
export function shiftAgendaDate(date: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
  const value = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Observed overlap only; a partial agenda cannot establish availability. */
export function agendaOverlaps(events: AgendaSnapshot['events']) {
  const spans = events.filter(event => event.status !== 'cancelled' && event.busy !== false && event.start.dateTime && event.end.dateTime)
    .map(event => ({id: event.id, start: Date.parse(event.start.dateTime!), end: Date.parse(event.end.dateTime!)}))
    .filter(span => Number.isFinite(span.start) && span.end > span.start).sort((a, b) => a.start - b.start);
  const ids = new Set<string>();
  for (let index = 0; index < spans.length; index++) {
    const first = spans[index]!;
    for (let next = index + 1; next < spans.length && spans[next]!.start < first.end; next++) {ids.add(first.id); ids.add(spans[next]!.id);}
  }
  return ids;
}
