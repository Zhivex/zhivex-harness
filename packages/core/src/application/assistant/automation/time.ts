const minute = 60_000;
const cache = new Map<string, { start: number; end: number; due: number } | null>();
export function validZone(zone: string) {
  try { return zone.length <= 100 && !!new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; } catch { return false; }
}
function formatter(zone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function parts(format: Intl.DateTimeFormat, epoch: number) {
  const values = Object.fromEntries(format.formatToParts(epoch).map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
export function localDate(epoch: number, zone: string) { return parts(formatter(zone), epoch).date; }
export function addDay(date: string, days = 1) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10); }
/** First occurrence on folds; first existing minute after a spring gap. Entire skipped dates have no occurrence. */
export function dayWindow(date: string, zone: string, time = '00:00') {
  const key = `${date}|${zone}|${time}`;
  if (cache.has(key)) return cache.get(key)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validZone(zone) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('AUTOMATION_SCHEDULE_INVALID');
  const pivot = Date.parse(`${date}T00:00:00Z`), format = formatter(zone);
  let start: number | undefined, end: number | undefined, due: number | undefined;
  for (let at = pivot - 18 * 3600_000; at <= pivot + 42 * 3600_000; at += minute) {
    const value = parts(format, at);
    if (value.date === date) {
      start ??= at; if (value.time >= time) due ??= at;
    } else if (start !== undefined) { end = at; break; }
  }
  const result = start !== undefined && end !== undefined && due !== undefined ? { start, end, due } : null;
  if (cache.size >= 64) cache.clear(); cache.set(key, result); return result;
}
export function nextDaily(after: number, zone: string, time: string) {
  const date = localDate(after, zone);
  for (let i = 0; i < 8; i++) { const window = dayWindow(addDay(date, i), zone, time); if (window && window.due > after) return window.due; }
  throw new Error('AUTOMATION_SCHEDULE_INVALID');
}
