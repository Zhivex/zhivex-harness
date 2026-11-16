import {useEffect, useState} from 'react';
import {readPreference, writePreference} from '../local-preferences.js';
import type {PersonalSnapshot} from '@zhivex-ai/harness/application/protocol';

export function Proactive({projectId, disabled, onAsk, onSettings}: {projectId: string; disabled: boolean; onAsk(prompt: string): Promise<void>; onSettings(): void}) {
  const [snapshot, setSnapshot] = useState<PersonalSnapshot>(), [error, setError] = useState('');
  const [watch, setWatch] = useState(() => {
    try {const value = JSON.parse(readPreference('draft', projectId, 'reply-watch')); if (['requestId','source','threadId','baselineMessageId','expectedFrom','title','dueAt'].every(key => typeof value[key] === 'string')) return value as {requestId: string; source: 'google' | 'microsoft'; threadId: string; baselineMessageId: string; expectedFrom: string; title: string; dueAt: string};} catch {}
    return {requestId: crypto.randomUUID(), source: 'google' as 'google' | 'microsoft', threadId: '', baselineMessageId: '', expectedFrom: '', title: '', dueAt: ''};
  });
  const [preparing, setPreparing] = useState(false);
  const changeWatch = (patch: Partial<typeof watch>) => {const next = {...watch, ...patch, requestId: crypto.randomUUID()}; setWatch(next); if (!writePreference('draft', projectId, 'reply-watch', JSON.stringify(next))) setError('Could not save the local reply watch.');};
  const prepareWatch = async () => {
    if (preparing || disabled) return; setPreparing(true);
    try {const reference = await window.zhivex.prepareReplyWatch(projectId, {...watch, dueAt: new Date(watch.dueAt).toISOString()}); await ask('daily_write_apply_reply_watch', reference);}
    catch {setError('Could not prepare this reply watch. Check the connection and exact thread details.');}
    finally {setPreparing(false);}
  };
  const [policy, setPolicy] = useState({enabled: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, channel: 'web' as 'web' | 'telegram', calendar: true, tasks: true, replies: true, quietStart: '22:00', quietEnd: '08:00', maxPerDay: 5, bufferMinutes: 0});
  useEffect(() => {
    let disposed = false, first = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {const next = await window.zhivex.personalState(projectId); if (!disposed) {setSnapshot(next); setError(''); if (first && next.proactive?.policy) setPolicy(next.proactive.policy); first = false;}}
      catch {if (!disposed) {setSnapshot(undefined); setError('Proactive state is unavailable. Missing data does not mean there are no alerts or replies.');}}
      finally {if (!disposed) timer = setTimeout(() => void read(), 3000);}
    };
    void read(); return () => {disposed = true; clearTimeout(timer);};
  }, [projectId]);
  const ask = (tool: string, input: unknown) => onAsk(`Use ${tool} with exactly this input: ${JSON.stringify(input)}. Request approval. Do not perform other actions. Report the actual result.`);
  return <section className="panel code-tools personal-tools" aria-label="Proactive alerts"><h2>Proactive alerts</h2>
    <p>Read-only detections with an explicit daily budget and quiet hours. Enabling this policy does not authorize sending email or changing your calendar. The host must remain running.</p>
    {error ? <p role="alert">{error}</p> : !snapshot ? <p role="status">Reading proactive state…</p> : null}
    {snapshot && !snapshot.proactive?.enabled ? <><p>Enable proactive tools in this assistant’s configuration first.</p><button onClick={onSettings}>Configure proactive tools</button></> : null}
    {snapshot?.proactive?.enabled ? <>
      <p role="status">Saved policy: {snapshot.proactive.policy?.enabled ? 'Active' : 'Paused or not configured'}</p>
      <form onSubmit={event => {event.preventDefault(); void ask('daily_write_configure_proactive', policy);}}>
        <label className="row"><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({...policy, enabled: event.target.checked})}/>Enable alerts</label>
        <label>Alert time zone<input required value={policy.timeZone} onChange={event => setPolicy({...policy, timeZone: event.target.value})}/></label>
        <label>Alert channel<select value={policy.channel} onChange={event => setPolicy({...policy, channel: event.target.value as 'web' | 'telegram'})}><option value="web">In-app</option><option value="telegram">Linked Telegram</option></select></label>
        <label>Quiet hours start<input type="time" required value={policy.quietStart} onChange={event => setPolicy({...policy, quietStart: event.target.value})}/></label>
        <label>Quiet hours end<input type="time" required value={policy.quietEnd} onChange={event => setPolicy({...policy, quietEnd: event.target.value})}/></label>
        <label>Maximum alerts per day<input type="number" min="1" max="20" required value={policy.maxPerDay} onChange={event => setPolicy({...policy, maxPerDay: Number(event.target.value)})}/></label>
        {(['calendar', 'tasks', 'replies'] as const).map(key => <label className="row" key={key}><input type="checkbox" checked={policy[key]} onChange={event => setPolicy({...policy, [key]: event.target.checked})}/>{key}</label>)}
        <button disabled={disabled}>Review proactive policy</button>
      </form>
      <p>Calendar source: {snapshot.proactive.sources?.calendar ? 'Connected' : 'Unavailable'}. Reply sources: {snapshot.proactive.sources?.replies.join(', ') || 'Unavailable'}.</p>
      {snapshot.proactive.health?.filter(item => item.status === 'unavailable').map(item => <p role="status" key={item.source}>Source {item.source} is unavailable. This does not mean there are no pending items.</p>)}
      <h3>Recent alerts</h3>{snapshot.proactive.alerts.length ? <ul>{snapshot.proactive.alerts.map(alert => <li key={alert.id}>{alert.text} · {alert.channel} · {alert.status}</li>)}</ul> : <p>No recorded alerts.</p>}
      <h3>Explicit reply watches</h3><p>Read the conversation first and use its exact thread and message IDs. A watch never sends mail.</p>
      <form onSubmit={event => {event.preventDefault(); void prepareWatch();}}>
        <label>Reply provider<select value={watch.source} onChange={event => changeWatch({source: event.target.value as 'google' | 'microsoft'})}><option value="google">Gmail</option><option value="microsoft">Outlook</option></select></label>
        <label>Watch title<input required maxLength={300} value={watch.title} onChange={event => changeWatch({title: event.target.value})}/></label>
        <label>Thread or conversation ID<input required value={watch.threadId} onChange={event => changeWatch({threadId: event.target.value})}/></label>
        <label>Baseline message ID<input required value={watch.baselineMessageId} onChange={event => changeWatch({baselineMessageId: event.target.value})}/></label>
        <label>Expected reply from<input type="email" required value={watch.expectedFrom} onChange={event => changeWatch({expectedFrom: event.target.value})}/></label>
        <label>Reply due (local time)<input type="datetime-local" required value={watch.dueAt} onChange={event => changeWatch({dueAt: event.target.value})}/></label>
        <button disabled={disabled || preparing || !snapshot.proactive.sources?.replies.includes(watch.source)}>Review reply watch</button>
      </form>
      {snapshot.proactive.watches.length ? <ul>{snapshot.proactive.watches.map(watch => <li key={watch.id}>{watch.title} · {watch.status} · {new Date(watch.due_at).toLocaleString()}<button disabled={disabled || watch.status !== 'waiting'} onClick={() => void ask('daily_write_cancel_reply_watch', {watchId: watch.id})}>Review stopping watch</button></li>)}</ul> : <p>No recorded reply watches.</p>}
    </> : null}
  </section>;
}
