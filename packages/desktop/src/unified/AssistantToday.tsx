import {useEffect, useState} from 'react';
import {ArrowUpRight, CalendarDays, CheckCheck, ShieldCheck, Zap} from 'lucide-react';
import type {AgendaSnapshot, AutomationSnapshot, PersonalSnapshot} from '@zhivex-ai/harness/application/protocol';
import type {HarnessClientSession} from '@zhivex-ai/harness/protocol';
import {agendaOverlaps, localAgendaDate} from './today-state.js';

type Read<T> = {status: 'loading' | 'error'; value?: undefined} | {status: 'ready'; value: T};
type Overview = {agenda: Read<AgendaSnapshot>; personal: Read<PersonalSnapshot>; automation: Read<AutomationSnapshot>};
const empty = (): Overview => ({agenda: {status: 'loading'}, personal: {status: 'loading'}, automation: {status: 'loading'}});
export function AssistantToday({projectId, sessions, sessionsReady, disconnected, onAgenda, onTasks, onAutomations, onSettings, onReview, onConversation}: {
  projectId: string; sessions: HarnessClientSession[]; sessionsReady: boolean; disconnected: boolean;
  onAgenda(): void; onTasks(): void; onAutomations(): void; onSettings(): void; onReview(sessionId: string): void; onConversation(): void;
}) {
  const [overview, setOverview] = useState(empty), [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone, date = localAgendaDate(zone, now);
  useEffect(() => {const timer = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(timer);}, []);
  useEffect(() => {
    let disposed = false; setOverview(empty());
    const load = async <K extends keyof Overview>(key: K, operation: Promise<Overview[K]['value']>) => {
      try {const value = await operation; if (!disposed) setOverview(previous => ({...previous, [key]: {status: 'ready', value}}));}
      catch {if (!disposed) setOverview(previous => ({...previous, [key]: {status: 'error'}}));}
    };
    void Promise.all([load('agenda', window.zhivex.agenda(projectId, date, zone)), load('personal', window.zhivex.personalState(projectId)), load('automation', window.zhivex.automation(projectId))]);
    return () => {disposed = true;};
  }, [projectId, date, zone, refresh]);
  const agenda = overview.agenda.value, personal = overview.personal.value, automation = overview.automation.value;
  const events = agenda?.events.filter(event => event.status !== 'cancelled') ?? [], overlaps = agendaOverlaps(events);
  const pending = sessions.filter(session => session.runs.at(-1)?.status === 'waiting_approval');
  const reviewsKnown = sessionsReady && !disconnected;
  const hour = now.getHours(), greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  const time = (value: string) => new Intl.DateTimeFormat('en', {timeZone: zone, hour: '2-digit', minute: '2-digit'}).format(new Date(value));
  const schedule = automation?.state?.schedule;
  return <section className="today-dashboard" aria-label="Today overview">
    <header className="today-heading"><div><span className="eyebrow">YOUR DAY, WITH A LITTLE MORE CLARITY.</span><h1>{greeting}</h1><p>A calm overview of your day and the decisions that need you.</p></div><span className="today-date"><CalendarDays size={16}/>{new Intl.DateTimeFormat('en', {weekday: 'long', month: 'long', day: 'numeric', timeZone: zone}).format(now)}</span></header>
    <div className="today-summary" aria-label="Daily summary">
      <span><CalendarDays size={16}/>{overview.agenda.status === 'loading' ? 'Reading calendar…' : overview.agenda.status === 'error' ? 'Calendar unavailable' : !agenda?.connected ? 'No calendar connected' : `${events.length}${agenda.complete ? '' : '+'} events today`}</span>
      <span><ShieldCheck size={16}/>{reviewsKnown ? `${pending.length} ${pending.length === 1 ? "conversation" : "conversations"} to review` : disconnected ? 'Reviews unavailable' : 'Reading reviews…'}</span>
      <span><CheckCheck size={16}/>{overview.personal.status === 'loading' ? 'Reading tasks…' : overview.personal.status === 'error' ? 'Tasks unavailable' : personal?.enabled ? `${personal.total} ${personal.total === 1 ? "task" : "tasks"} to do` : 'Tasks not enabled'}</span>
      <button className="ghost" onClick={() => {setNow(new Date()); setRefresh(value => value + 1);}}>Refresh overview</button>
    </div>
    <div className="today-grid">
      <section className="panel agenda-card"><div className="panel-head"><h2>Your agenda</h2><button className="ghost" onClick={onAgenda}>View agenda <ArrowUpRight size={14}/></button></div><div className="panel-content">
        {overview.agenda.status === 'loading' ? <p role="status">Reading your calendar…</p> : overview.agenda.status === 'error' ? <p role="alert">Your calendar could not be read. Refresh to retry.</p> : !agenda?.connected ? <div className="today-empty"><CalendarDays/><h3>Make room for your day.</h3><p>Connect a calendar to see your events here.</p><button className="secondary" onClick={onSettings}>Calendar settings</button></div> : <>
          {!agenda.complete ? <p role="alert">This agenda is incomplete. Missing events do not mean free time.</p> : null}
          {events.length ? <ul className="today-events">{events.slice(0, 5).map(event => <li key={event.id} className={overlaps.has(event.id) ? 'has-overlap' : ''}><span className="event-time">{event.start.date ? 'All day' : time(event.start.dateTime!)}<small>{event.end.dateTime ? time(event.end.dateTime) : ''}</small></span><div><strong>{event.summary || '(Untitled event)'}</strong><p>{agenda.calendarId}{event.busy === false ? ' · Free' : ''}</p></div>{overlaps.has(event.id) ? <span className="badge attention">Overlap</span> : null}</li>)}</ul> : <div className="today-empty"><CalendarDays/><h3>{agenda.complete ? 'A little breathing room.' : 'No events retrieved.'}</h3><p>{agenda.complete ? 'No events on your calendar for today.' : 'Refresh or open your agenda to check the connection.'}</p></div>}
          {events.length > 5 ? <p>Showing 5 of {events.length} events. Open your agenda for the rest.</p> : null}
        </>}
      </div><div className="card-footnote">{zone}</div></section>
      <div className="today-stack">
        <section className="panel"><div className="panel-head"><h2><ShieldCheck size={16}/> Your decisions</h2>{reviewsKnown && pending.length ? <span className="badge attention">Needs review</span> : null}</div><div className="panel-content">
          {!reviewsKnown ? <p role="status">{disconnected ? 'Reconnect to check pending decisions.' : 'Reading pending decisions…'}</p> : pending.length ? <><h3>{pending.length === 1 ? 'An action needs your attention.' : `${pending.length} conversations are waiting.`}</h3><p>Review the exact action and its effects before deciding.</p><ul className="decision-shortlist">{pending.map(session => <li key={session.sessionId}><button className="secondary" onClick={() => onReview(session.sessionId)}>{session.title || 'Untitled conversation'} <ArrowUpRight size={14}/></button></li>)}</ul><p className="fine">Nothing changes until you approve.</p></> : <><h3>You’re all caught up.</h3><p>No conversation is currently waiting for your review.</p><button className="secondary" onClick={onConversation}>Open conversation</button></>}
        </div></section>
        <section className="panel"><div className="panel-head"><h2><Zap size={16}/> Your daily briefing</h2>{schedule ? <span className="badge">{schedule.enabled ? 'Active' : 'Paused'}</span> : null}</div><div className="panel-content">
          {overview.automation.status === 'loading' ? <p role="status">Reading your schedule…</p> : overview.automation.status === 'error' ? <p role="alert">Your briefing schedule could not be read.</p> : schedule ? <p>{schedule.enabled ? `Next scheduled: ${new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'short', timeZone: zone}).format(schedule.next_at)} · ${zone}` : 'Your daily briefing is paused.'} · Telegram</p> : <p>{automation?.available ? 'Your agenda and priorities, together. Set up a daily briefing when you’re ready.' : 'Enable a supported source and Telegram to schedule a daily briefing.'}</p>}
          <button className="secondary" onClick={onAutomations}>Manage briefing <ArrowUpRight size={14}/></button>
        </div></section>
        <section className="panel"><div className="panel-head"><h2><CheckCheck size={16}/> Tasks to do</h2><button className="ghost" onClick={onTasks}>View tasks <ArrowUpRight size={14}/></button></div><div className="panel-content">
          {overview.personal.status === 'loading' ? <p role="status">Reading tasks…</p> : overview.personal.status === 'error' ? <p role="alert">Tasks could not be read. Refresh to retry.</p> : !personal?.enabled ? <><p>Tasks are not enabled for this assistant.</p><button className="secondary" onClick={onSettings}>Configure tasks</button></> : personal.tasks.length ? <ul className="today-tasks">{personal.tasks.slice(0, 3).map(task => <li key={task.id}><strong>{task.title}</strong><span>{task.due_date ? `Due ${task.due_date}` : 'No due date'}</span></li>)}</ul> : <p>No pending tasks.</p>}
          {personal?.enabled ? <details><summary>Saved reminders ({personal.reminders.length})</summary><p>Up to five saved reminders, latest scheduled time first; includes completed and uncertain deliveries.</p>{personal.reminders.length ? <ul className="today-tasks">{personal.reminders.slice(0, 5).map(reminder => <li key={reminder.id}><div><strong>{reminder.text}</strong><p>{new Intl.DateTimeFormat('en', {timeZone: reminder.time_zone, dateStyle: 'medium', timeStyle: 'short'}).format(reminder.due_at)} · {reminder.time_zone}</p><p>{reminder.channel === 'web' ? 'In app' : 'Telegram'} · {reminder.status.replaceAll('_', ' ')}</p>{reminder.status === 'uncertain' ? <p>Delivery is uncertain. Review its history before creating another reminder.</p> : null}</div></li>)}</ul> : <p>No saved reminders.</p>}<button className="secondary" onClick={onTasks}>Manage tasks &amp; reminders</button></details> : null}
          {personal && personal.total > 3 ? <p>Showing {Math.min(3, personal.tasks.length)} of {personal.total} pending tasks.</p> : null}
        </div></section>
      </div>
    </div>
  </section>;
}
