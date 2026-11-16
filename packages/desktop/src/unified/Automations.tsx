import {useEffect, useState} from 'react';
import type {AutomationSnapshot, AutomationChange} from '@zhivex-ai/harness/application/protocol';

function preferenceValue(value: string) { try {return String(JSON.parse(value));} catch {return value;} }

export function Automations({projectId, onSettings}: {projectId: string; onSettings(): void}) {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [localTime, setLocalTime] = useState('08:00'), [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [review, setReview] = useState<AutomationChange>(), [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    if (busy || review) return;
    const load = async () => {
      try {const state = await window.zhivex.automation(projectId); if (!disposed) {setSnapshot(state);}}
      catch {if (!disposed) {setSnapshot(undefined); setError('Automation state is unavailable. Refresh before making changes.');}}
      finally {if (!disposed) timer = setTimeout(() => void load(), 3000);}
    };
    void load(); return () => {disposed = true; if (timer) clearTimeout(timer);};
  }, [projectId, busy, review, refresh]);
  const prepare = (action: AutomationChange['action']) => {
    if (!snapshot) return;
    setError(''); setConfirmed(false);
    setReview({action, expectedDigest: snapshot.digest, confirmed: true, ...(action === 'configure' ? {localTime, timeZone} : {})});
  };
  const apply = async () => {
    if (!review || !confirmed || busy) return;
    setBusy(true); setError('');
    try {setSnapshot(await window.zhivex.automation(projectId, review)); setReview(undefined);}
    catch {setReview(undefined); setSnapshot(undefined); setError('The change was not confirmed. Read the saved state before reviewing another action; do not assume a failed response means no change occurred.');}
    finally {setBusy(false);}
  };
  const schedule = snapshot?.state?.schedule;
  return <section className="panel code-tools personal-tools" aria-label="Automations">
    <h2>Daily summary</h2><p>Receive a read-only daily summary through your linked Telegram account.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!snapshot && !error ? <p role="status">Reading automation state…</p> : null}
    <button className="secondary" disabled={busy || Boolean(review)} onClick={() => {setError(''); setRefresh(value => value + 1);}}>Refresh automation</button>
    {snapshot && !snapshot.available ? <div><p>A configured summary source and Telegram connection are required. This assistant has no daily-summary scheduler.</p><button onClick={onSettings}>Assistant settings</button></div> : null}
    {snapshot?.available ? <>
      <p role="status">{schedule ? schedule.enabled ? 'Active' : 'Paused' : 'Not configured'} · Delivery: Telegram · {snapshot.linked ? 'Account linked' : 'Account not linked'}</p>
      {schedule?.enabled ? <p>Next scheduled time (this computer’s time zone): {new Date(schedule.next_at).toLocaleString()}. Requires the host to remain running; sleep can delay delivery.</p> : null}
      <h3>Saved preferences</h3>{!snapshot.state?.preferences.length ? <p>No saved preferences.</p> : null}<dl>{snapshot.state?.preferences.map(item => <div key={item.key}><dt>{({timeZone: "Time zone", localTime: "Local time", calendarId: "Calendar", conflictBufferMinutes: "Conflict buffer (minutes)"} as Record<string, string>)[item.key] ?? item.key}</dt><dd>{preferenceValue(item.value)}</dd></div>)}</dl>
      <form onSubmit={event => {event.preventDefault(); prepare('configure');}}>
        <label>Summary local time<input type="time" required value={localTime} onChange={event => setLocalTime(event.target.value)} disabled={busy || Boolean(review)} /></label>
        <label>Summary time zone<input required value={timeZone} onChange={event => setTimeZone(event.target.value)} disabled={busy || Boolean(review)} /></label>
        <button disabled={busy || Boolean(review) || !snapshot.linked}>Review schedule and activation</button>
      </form>
      <div className="row">
        <button className="secondary" disabled={busy || Boolean(review) || !schedule} onClick={() => prepare(schedule?.enabled ? 'pause' : 'resume')}>{schedule?.enabled ? 'Review pause' : 'Review resume'}</button>
        <button className="secondary" disabled={busy || Boolean(review) || !schedule} onClick={() => prepare('delete')}>Review deletion</button>
        <button className="secondary" disabled={busy || Boolean(review)} onClick={() => prepare('forget')}>Review forgetting preferences</button>
      </div>
      <h3>Recent occurrences</h3><p>Enqueued means queued for delivery, not confirmed receipt. Failed or uncertain deliveries are not retried from this screen.</p>
      {!snapshot.state?.occurrences.length ? <p>No recorded occurrences.</p> : <ul>{snapshot.state.occurrences.map(item => <li key={item.id}>{item.day} · {item.status} · attempts: {item.attempts}</li>)}</ul>}
    </> : null}
    {review ? <section aria-label="Review automation change"><h3>Review automation change</h3>
      <p>Action: {review.action}{review.action === 'configure' ? ` · ${review.localTime} · ${review.timeZone} · Deliver daily through Telegram` : ''}</p>
      <p>{['configure', 'resume'].includes(review.action) ? 'This authorizes future daily summaries to the linked Telegram account from the next scheduled time.' : 'Pausing or deleting cancels pending deliveries. A delivery already started cannot be recalled. Forgetting clears saved preferences and pauses the schedule.'}</p>
      <label className="automation-confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />I reviewed this automation change</label>
      <div className="row"><button disabled={busy || !confirmed} onClick={() => void apply()}>Confirm automation change</button><button className="secondary" disabled={busy} onClick={() => setReview(undefined)}>Cancel review</button></div>
    </section> : null}
  </section>;
}
