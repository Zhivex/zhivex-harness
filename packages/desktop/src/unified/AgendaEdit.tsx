import {useState} from 'react';
import type {AgendaSnapshot} from '@zhivex-ai/harness/application/protocol';
export function AgendaEdit({event, disabled, onAsk, onClose}: {
  event: AgendaSnapshot['events'][number]; disabled: boolean; onAsk(prompt: string): Promise<void>; onClose(): void;
}) {
  const [summary, setSummary] = useState(event.summary);
  const [start, setStart] = useState(() => new Date(event.start.dateTime!).toISOString().slice(0, -1));
  const [end, setEnd] = useState(() => new Date(event.end.dateTime!).toISOString().slice(0, -1));
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    const from = Date.parse(start + 'Z'), to = Date.parse(end + 'Z');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {setError('Choose an end time after the start time. Both times are UTC.'); return;}
    const input = {eventId: event.id, change: {summary, start: new Date(from).toISOString(), end: new Date(to).toISOString()}};
    try {await onAsk(`Use calendar_read_propose with exactly this input: ${JSON.stringify(input)}. Then request approval with calendar_write_apply using the unchanged operationId and proposalDigest returned by the core. Do not modify any other event. If the proposal is unsupported or conflicts, stop and explain the actual result. Reconcile uncertain outcomes with calendar_read_reconcile; never repeat a write automatically.`);}
    catch {setError('The request could not be confirmed. Inspect the conversation before trying again.');}
  };
  return <form aria-label="Edit calendar event" onSubmit={event => {event.preventDefault(); void submit();}}>
    <h3>Request an event change</h3>
    <p>Only timed, non-recurring events you organize are supported. The core checks the current event before proposing a change. Approved changes request notifications to all attendees.</p>
    <label>Event title<input maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} /></label>
    <label>Event start (UTC)<input type="datetime-local" step="any" required value={start} onChange={event => setStart(event.target.value)} /></label>
    <label>Event end (UTC)<input type="datetime-local" step="any" required value={end} onChange={event => setEnd(event.target.value)} /></label>
    <p>These fields use UTC, independently of the agenda display time zone. Review the exact times and attendees before approving.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="row"><button disabled={disabled}>Ask to change event</button><button type="button" className="secondary" onClick={onClose}>Cancel event edit</button></div>
  </form>;
}
