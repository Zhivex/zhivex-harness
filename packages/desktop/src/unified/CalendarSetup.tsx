import {useState} from 'react';
import type {AssistantSetupState} from './bridge.js';

export function CalendarSetup({state, busy, act}: {state: AssistantSetupState['calendar']; busy: boolean; act(action: string, value?: unknown): Promise<boolean>}) {
  const [allowCreate, setAllowCreate] = useState(state.allowCreate);
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState(''), [error, setError] = useState('');
  async function open() {setError(''); try {await window.zhivex.openCalendarAuthorization();} catch {setError('Could not open Google authorization. Use Open authorization again while the request is pending.');}}
  async function begin() {
    const secret = clientSecret; setClientSecret(''); setError('');
    if (await act('calendar', {allowCreate, ...(clientId.trim() ? {clientId: clientId.trim()} : {}), ...(secret ? {clientSecret: secret} : {})})) await open();
  }
  return <section className="connection-section" aria-label="Google Calendar connection">
    <h3>Google Calendar (optional)</h3><p>Connect your calendar for agenda queries and summaries. Event changes still require review in your conversation. Google will show the requested permissions before you consent.</p>
    {error ? <p role="alert">{error}</p> : null}
    {state.connected ? <p role="status">Calendar connected: {state.email}</p> : null}
    {state.pending ? <div><p role="status">Waiting for Google authorization in your browser. This request expires after ten minutes. Keep the app open.</p><div className="row"><button type="button" disabled={busy} onClick={() => void open()}>Open Calendar authorization</button><button type="button" className="secondary" disabled={busy} onClick={() => void act('calendar-cancel')}>Cancel Calendar authorization</button></div></div> : null}
    {!state.pending ? <form onSubmit={event => {event.preventDefault(); void begin();}}>
      <p>{state.available ? 'A Google OAuth client is configured on this host. Leave these fields blank to use it.' : 'Provide your Google OAuth client configuration for a desktop application.'}</p>
      <label>Google OAuth client ID<input value={clientId} onChange={event => setClientId(event.target.value)} disabled={busy} required={!state.available && !state.connected} autoComplete="off" /></label>
      <label>Google OAuth client secret (optional)<input type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} disabled={busy} autoComplete="off" /></label>
      <label className="row"><input type="checkbox" checked={allowCreate} onChange={event => setAllowCreate(event.target.checked)} disabled={busy} />Enable reviewed event creation for this assistant</label>
      <button className="secondary" disabled={busy}>{state.connected ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}</button>
    </form> : null}
  </section>;
}
