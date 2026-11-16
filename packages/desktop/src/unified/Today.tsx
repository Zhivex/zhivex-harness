import {AgendaCreate} from './AgendaCreate.js';
import {AgendaEdit} from './AgendaEdit.js';
import {useEffect, useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {localAgendaDate as currentDate, shiftAgendaDate} from './today-state.js';
import type {AgendaSnapshot} from '@zhivex-ai/harness/application/protocol';

export function Today({projectId, onSettings, onTasks, disabled, onAsk}: {projectId: string; onSettings(): void; onTasks(): void; disabled: boolean; onAsk(prompt: string): Promise<void>}) {
  const [editing, setEditing] = useState<AgendaSnapshot['events'][number]>();
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone), [date, setDate] = useState(() => currentDate(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [query, setQuery] = useState({date, timeZone}), [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<AgendaSnapshot>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [updated, setUpdated] = useState('');
  useEffect(() => {
    let disposed = false; setEditing(undefined); setLoading(true); setSnapshot(undefined); setError('');
    void window.zhivex.agenda(projectId, query.date, query.timeZone).then(value => {if (!disposed) {setSnapshot(value); setUpdated(new Date().toLocaleTimeString());}}).catch(() => {if (!disposed) setError('Could not read this calendar. Retry or review the connection. Unavailable data does not mean there are no events.');}).finally(() => {if (!disposed) setLoading(false);});
    return () => {disposed = true;};
  }, [projectId, query, refresh]);
  function select(today: boolean) {
    try {const nextDate = today ? currentDate(timeZone) : date; new Intl.DateTimeFormat('en', {timeZone}); setDate(nextDate); setQuery({date: nextDate, timeZone});}
    catch {setError('Enter a valid IANA time zone, such as America/Argentina/Buenos_Aires.');}
  }
  const clock = (value: string) => new Intl.DateTimeFormat('en', {timeZone: snapshot?.timeZone, hour: '2-digit', minute: '2-digit'}).format(new Date(value));
  function move(days: number) {
    try {const nextDate = shiftAgendaDate(query.date, days); setDate(nextDate); setQuery({...query, date: nextDate});}
    catch {setError('Choose a valid agenda date.');}
  }
  return <section className="panel code-tools personal-tools" aria-label="Agenda">
    <h2>Agenda</h2><p>Your calendar, one day at a time. Changes stay subject to your review.</p>
    <div className="row agenda-day-controls"><button className="secondary" aria-label="Previous day" disabled={loading} onClick={() => move(-1)}><ChevronLeft size={16}/></button><strong>{query.date}</strong><button className="secondary" aria-label="Next day" disabled={loading} onClick={() => move(1)}><ChevronRight size={16}/></button><button className="secondary" disabled={loading} onClick={() => select(true)}>Today</button></div>
    <form onSubmit={event => {event.preventDefault(); select(false);}}>
      <label>Agenda date<input type="date" value={date} onChange={event => setDate(event.target.value)} required /></label>
      <label>Agenda time zone<input value={timeZone} onChange={event => setTimeZone(event.target.value)} required /></label>
      <div className="row"><button disabled={loading}>Show agenda</button></div>
    </form>
    <div className="row"><button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh agenda</button><button className="secondary" onClick={onTasks}>Tasks &amp; reminders</button></div>
    {loading ? <p role="status">Reading calendar…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {snapshot && !snapshot.connected ? <div><p>No calendar is connected to this assistant.</p><button onClick={onSettings}>Assistant settings</button></div> : null}
    {snapshot?.connected ? <>
      {snapshot.canCreate ? <AgendaCreate projectId={projectId} disabled={disabled} onAsk={onAsk} /> : null}
      <h3>{snapshot.date} · {snapshot.timeZone}</h3><p>Calendar: {snapshot.calendarId} · Refreshed {updated}</p>
      {!snapshot.complete ? <p role="alert">This agenda is incomplete. Only the events below were retrieved; missing events must not be treated as free time. Refresh to try again.</p> : null}
      {!snapshot.events.length ? <p>{snapshot.complete ? 'No events for this date.' : 'No events could be shown from this partial result.'}</p> : <ul className="personal-list">{snapshot.events.map(event => <li key={event.id}><div><strong>{event.summary || '(Untitled event)'}</strong><p>{event.start.date ? 'All day' : `${clock(event.start.dateTime!)}–${clock(event.end.dateTime!)}`}{event.status === 'cancelled' ? ' · Cancelled' : event.busy === false ? ' · Free' : ''}</p></div>{event.start.dateTime && event.end.dateTime && event.status !== 'cancelled' ? <button className="secondary" disabled={disabled} onClick={() => setEditing(event)}>Edit event</button> : null}</li>)}</ul>}
      {editing ? <AgendaEdit key={editing.id} event={editing} disabled={disabled} onAsk={onAsk} onClose={() => setEditing(undefined)} /> : null}
    </> : null}
  </section>;
}
