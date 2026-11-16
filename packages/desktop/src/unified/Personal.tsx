import {useEffect, useState} from 'react';
import type {PersonalSnapshot} from '@zhivex-ai/harness/application/protocol';

export function Personal({projectId, disabled, hasSession, onAsk, onSettings, onConversation}: {projectId: string; disabled: boolean; hasSession: boolean; onAsk(prompt: string): Promise<void>; onSettings(): void; onConversation(): void}) {
  const [snapshot, setSnapshot] = useState<PersonalSnapshot>(), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [title, setTitle] = useState(''), [dueDate, setDueDate] = useState('');
  const [text, setText] = useState(''), [date, setDate] = useState(''), [time, setTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [taskId, setTaskId] = useState(() => crypto.randomUUID()), [reminderId, setReminderId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined; setLoading(true); setError(''); setSnapshot(undefined);
    const load = async () => {
      try {const value = await window.zhivex.personalState(projectId, offset); if (!disposed) {setSnapshot(value); setError('');}}
      catch {if (!disposed) {setSnapshot(undefined); setError('Could not read this assistant’s tasks. Reconnect and refresh; unavailable data does not mean the list is empty.');}}
      finally {if (!disposed) {setLoading(false); timer = setTimeout(() => void load(), 3000);}}
    };
    void load();
    return () => {disposed = true; if (timer) clearTimeout(timer);};
  }, [projectId, offset, refresh]);
  const ask = (tool: string, input: unknown) => onAsk(`Use ${tool} with exactly this input: ${JSON.stringify(input)}. Request approval before changing data. Do not perform other actions. Report the actual result.`);
  const locked = disabled || loading || !snapshot?.enabled;
  const editTask = () => setTaskId(crypto.randomUUID()), editReminder = () => setReminderId(crypto.randomUUID());
  return <section className="panel code-tools personal-tools" aria-label="Tasks and reminders">
    <h2>Tasks & reminders</h2><p>Saved by this assistant. Actions are proposed in your conversation and require review before they change anything.</p>
    <div className="row"><button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh tasks</button><button className="secondary" onClick={onConversation}>View conversation</button></div>
    {loading ? <p role="status">Loading saved tasks…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {snapshot && !snapshot.enabled ? <div><p>Tasks and reminders are not enabled for this assistant. Enable them when configuring an assistant.</p><button onClick={onSettings}>Assistant settings</button></div> : null}
    {snapshot?.enabled ? <>
      {!hasSession ? <p>Create or select a conversation before requesting changes.</p> : null}
      <h3>Pending tasks <span className="muted">({snapshot.total})</span></h3>
      {snapshot.tasks.length === 0 ? <p>No pending tasks on this page.</p> : <ul className="personal-list">{snapshot.tasks.map(task => <li key={task.id}><div><strong>{task.title}</strong><p>{task.due_date ? `Due ${task.due_date}` : 'No due date'}</p></div><button className="secondary" disabled={locked} onClick={() => void ask('daily_write_complete_task', {requestId: crypto.randomUUID(), taskId: task.id})}>Ask to complete</button></li>)}</ul>}
      <div className="row"><button className="secondary" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous tasks</button><button className="secondary" disabled={loading || snapshot.nextOffset === null} onClick={() => setOffset(snapshot.nextOffset!)}>More tasks</button></div>
      <form onSubmit={event => {event.preventDefault(); void ask('daily_write_create_task', {requestId: taskId, title: title.trim(), ...(dueDate ? {dueDate} : {})});}}>
        <h3>New task</h3><label>Task title<input required maxLength={500} value={title} onChange={event => {setTitle(event.target.value); editTask();}} /></label>
        <label>Due date (optional)<input type="date" value={dueDate} onChange={event => {setDueDate(event.target.value); editTask();}} /></label>
        <button disabled={locked || !title.trim()}>Ask to create task</button>
      </form>
      <h3>Reminders</h3><p>The most recent 100 reminders. In-app reminders appear here while the host is running; they are not operating-system notifications. Delivery may be delayed when the app is stopped or the computer is asleep.</p>
      {snapshot.reminders.length === 0 ? <p>No saved reminders.</p> : <ul className="personal-list">{snapshot.reminders.map(reminder => <li key={reminder.id}><div><strong>{reminder.text}</strong><p>{new Intl.DateTimeFormat('en-US', {timeZone: reminder.time_zone, dateStyle: 'medium', timeStyle: 'short'}).format(reminder.due_at)} · {reminder.time_zone}</p><p>{reminder.channel === 'web' ? 'In app' : 'Telegram'} · {reminder.status.replaceAll('_', ' ')}</p>{reminder.status === 'uncertain' ? <p>Delivery is uncertain. Inspect its history before creating another reminder.</p> : null}</div>{['pending', 'available'].includes(reminder.status) ? <button className="secondary" disabled={locked} onClick={() => void ask('daily_write_cancel_reminder', {requestId: crypto.randomUUID(), reminderId: reminder.id})}>{reminder.status === 'available' ? 'Ask to dismiss' : 'Ask to cancel'}</button> : null}</li>)}</ul>}
      <form onSubmit={event => {event.preventDefault(); void ask('daily_write_schedule_reminder', {requestId: reminderId, text: text.trim(), date, localTime: time, timeZone, channel: 'web'});}}>
        <h3>New in-app reminder</h3><label>Reminder text<input required maxLength={500} value={text} onChange={event => {setText(event.target.value); editReminder();}} /></label>
        <div className="row"><label>Reminder date<input type="date" required value={date} onChange={event => {setDate(event.target.value); editReminder();}} /></label><label>Reminder time<input type="time" required value={time} onChange={event => {setTime(event.target.value); editReminder();}} /></label></div>
        <label>Time zone<input required value={timeZone} onChange={event => {setTimeZone(event.target.value); editReminder();}} placeholder="America/Argentina/Buenos_Aires" /></label>
        <p>The review confirms the exact scheduled time, including daylight-saving adjustments.</p><button disabled={locked || !text.trim() || !date || !time || !timeZone}>Ask to schedule reminder</button>
      </form>
    </> : null}
  </section>;
}
