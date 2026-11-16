import {useEffect, useState} from 'react';
import type {PersonalSnapshot} from '@zhivex-ai/harness/application/protocol';

/** A bounded, read-only overview; the task screen owns pagination and reviewed changes. */
export function PersonalOverview({projectId, onTasks, onSettings}: {
  projectId: string; onTasks(): void; onSettings(): void;
}) {
  const [snapshot, setSnapshot] = useState<PersonalSnapshot>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    setSnapshot(undefined); setLoading(true); setError(false);
    void window.zhivex.personalState(projectId).then(value => {
      if (!disposed) setSnapshot(value);
    }).catch(() => {
      if (!disposed) setError(true);
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {disposed = true;};
  }, [projectId, refresh]);
  return <section aria-label="Personal overview">
    <h3>Tasks &amp; reminders</h3>
    <p>Current saved state for this assistant, independent of the agenda date.</p>
    <div className="row">
      <button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh overview</button>
      <button className="secondary" onClick={onTasks}>Manage tasks &amp; reminders</button>
    </div>
    {loading ? <p role="status">Reading tasks and reminders…</p> : null}
    {error ? <p role="alert">Tasks and reminders could not be read. Refresh to retry; unavailable data does not mean there are none.</p> : null}
    {snapshot && !snapshot.enabled ? <div><p>Tasks and reminders are not enabled for this assistant.</p><button className="secondary" onClick={onSettings}>Configure tasks &amp; reminders</button></div> : null}
    {snapshot?.enabled ? <>
      <h4>Pending tasks ({snapshot.total})</h4>
      {snapshot.tasks.length ? <ul className="personal-list">{snapshot.tasks.slice(0, 5).map(task => <li key={task.id}><div><strong>{task.title}</strong><p>{task.due_date ? `Due ${task.due_date}` : 'No due date'}</p></div></li>)}</ul> : <p>No pending tasks.</p>}
      {snapshot.total > 5 ? <p>Showing {Math.min(snapshot.tasks.length, 5)} of {snapshot.total} pending tasks. Open Tasks &amp; reminders to see more.</p> : null}
      <h4>Reminder preview</h4>
      <p>Up to five saved reminders, latest scheduled time first, including completed and uncertain deliveries. Open Tasks &amp; reminders to review or request changes.</p>
      {snapshot.reminders.length ? <ul className="personal-list">{snapshot.reminders.slice(0, 5).map(reminder => <li key={reminder.id}><div><strong>{reminder.text}</strong><p>{new Intl.DateTimeFormat('en-US', {timeZone: reminder.time_zone, dateStyle: 'medium', timeStyle: 'short'}).format(reminder.due_at)} · {reminder.time_zone}</p><p>{reminder.channel === 'web' ? 'In app' : 'Telegram'} · {reminder.status.replaceAll('_', ' ')}</p>{reminder.status === 'uncertain' ? <p>Delivery is uncertain. Review its history before creating another reminder.</p> : null}</div></li>)}</ul> : <p>No saved reminders.</p>}
    </> : null}
  </section>;
}
