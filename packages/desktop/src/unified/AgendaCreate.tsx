import {useEffect, useRef, useState} from 'react';
import {readPreference, writePreference} from '../local-preferences.js';
function savedDraft(projectId: string) {
  try {const value = JSON.parse(readPreference('calendar-create-draft', projectId, '')); if (value.version === 1 && /^[0-9a-f-]{36}$/.test(value.requestId) && ['title', 'start', 'end', 'attendees'].every(key => typeof value[key] === 'string') && value.title.length <= 1000 && value.start.length <= 30 && value.end.length <= 30 && value.attendees.length <= 32100) return value as {title: string; start: string; end: string; attendees: string; requestId: string};} catch {}
  return {title: '', start: '', end: '', attendees: '', requestId: crypto.randomUUID()};
}
export function AgendaCreate({projectId, disabled, onAsk}: {projectId: string; disabled: boolean; onAsk(prompt: string): Promise<void>}) {
  const mounted = useRef(true), pending = useRef(false);
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const [initial] = useState(() => savedDraft(projectId));
  const [title, setTitle] = useState(initial.title), [start, setStart] = useState(initial.start), [end, setEnd] = useState(initial.end), [attendees, setAttendees] = useState(initial.attendees);
  const [requestId, setRequestId] = useState(initial.requestId), [error, setError] = useState('');
  useEffect(() => {writePreference('calendar-create-draft', projectId, '', JSON.stringify({version: 1, title, start, end, attendees, requestId}));}, [projectId, title, start, end, attendees, requestId]);
  const changed = () => setRequestId(crypto.randomUUID());
  const submit = async () => {
    if (pending.current || disabled) return;
    setError('');
    const from = Date.parse(start + 'Z'), to = Date.parse(end + 'Z');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {setError('Choose an end time after the start time. Both times are UTC.'); return;}
    const guests = attendees.split('\n').map(value => value.trim()).filter(Boolean);
    if (guests.length > 100 || guests.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {setError('Enter up to 100 email addresses, one per line.'); return;}
    const input = {requestId, summary: title.trim(), start: new Date(from).toISOString(), end: new Date(to).toISOString(), attendees: guests};
    pending.current = true; setPreparing(true);
    try {const reference = await window.zhivex.prepareCalendarCreation(projectId, input); if (!mounted.current) return; await onAsk(`Use calendar_write_create with exactly this input: ${JSON.stringify(reference)}. Request approval before creating this event. Create no other event. If the outcome is uncertain, use calendar_read_reconcile_create with this operationId; never invent a replacement request or repeat a write.`);}
    catch {if (mounted.current) setError('The request could not be confirmed. Inspect the conversation before trying again.');}
    finally {pending.current = false; if (mounted.current) setPreparing(false);}
  };
  return <details><summary>New calendar event</summary><form aria-label="Create calendar event" onSubmit={event => {event.preventDefault(); void submit();}}>
    <p>Create a timed, non-recurring event after reviewing its exact times and attendees. Times below use UTC.</p>
    <label>New event title<input required maxLength={1000} value={title} onChange={event => {setTitle(event.target.value); changed();}} /></label>
    <label>New event start (UTC)<input type="datetime-local" step="any" required value={start} onChange={event => {setStart(event.target.value); changed();}} /></label>
    <label>New event end (UTC)<input type="datetime-local" step="any" required value={end} onChange={event => {setEnd(event.target.value); changed();}} /></label>
    <label>Attendee emails (one per line)<textarea value={attendees} maxLength={32100} onChange={event => {setAttendees(event.target.value); changed();}} /></label>
    <p>Approval requests notifications to all attendees. An uncertain creation must be reconciled before requesting another event.</p>
    {error ? <p role="alert">{error}</p> : null}<button disabled={disabled || preparing || !title.trim()}>Ask to create event</button>
  </form></details>;
}
