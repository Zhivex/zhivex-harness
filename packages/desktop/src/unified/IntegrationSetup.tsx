import {useState} from 'react';
import type {AssistantSetupState} from './bridge.js';
import {Button, Notice} from './ui.js';

export function IntegrationSetup({state, busy, act}: {state: AssistantSetupState; busy: boolean; act(action: string, value?: unknown): Promise<boolean>}) {
  const [clientId, setClientId] = useState(''), [secret, setSecret] = useState(''), [tenant, setTenant] = useState(state.microsoft.tenantId ?? '');
  const [mail, setMail] = useState(true), [drive, setDrive] = useState(false), [calendar, setCalendar] = useState(false), [error, setError] = useState('');
  async function open() {try {await window.zhivex.openCalendarAuthorization();} catch {setError('Could not open authorization. Reopen it while the request is pending.');}}
  async function connect(kind: 'google' | 'microsoft') {
    setError(''); const clientSecret = secret; setSecret('');
    const value = kind === 'google' ? {mail, drive, clientId, ...(clientSecret ? {clientSecret} : {})} : {clientId, tenantId: tenant, mail, calendar};
    if (await act(kind, value)) await open();
  }
  return <section className="connection-section" aria-label="Mail and knowledge connections"><h3>Mail, Drive and Microsoft</h3>
    <p>OAuth requests only the selected capabilities. Draft creation requires a separate review and never authorizes sending mail. One calendar source can be active per assistant.</p>
    {error ? <Notice>{error}</Notice> : null}
    {state.google.connected ? <p role="status">Google connected: {state.google.email} · {state.google.mail ? 'Gmail' : ''} {state.google.drive ? 'Drive' : ''}</p> : null}
    {state.microsoft.connected ? <p role="status">Microsoft connected: {state.microsoft.email}</p> : null}
    {state.calendar.pending ? <div><p role="status">Authorization pending. This does not mean the account is connected.</p><Button variant="secondary" disabled={busy} onClick={() => void open()}>Open account authorization</Button><Button variant="secondary" disabled={busy} onClick={() => void act('calendar-cancel')}>Cancel account authorization</Button></div> : <>
      <label>Account OAuth client ID<input value={clientId} onChange={event => setClientId(event.target.value)} disabled={busy}/></label>
      <label>Google account client secret (optional)<input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} disabled={busy}/></label>
      <label>Microsoft tenant ID (UUID)<input value={tenant} onChange={event => setTenant(event.target.value)} disabled={busy}/></label>
      <label className="row"><input type="checkbox" checked={mail} onChange={event => setMail(event.target.checked)}/>Enable mail read and reviewed drafts</label>
      <label className="row"><input type="checkbox" checked={drive} onChange={event => setDrive(event.target.checked)}/>Enable Google Drive read</label>
      <label className="row"><input type="checkbox" checked={calendar} onChange={event => setCalendar(event.target.checked)}/>Enable Outlook Calendar</label>
      <div className="row"><Button variant="secondary" disabled={busy || !clientId.trim() || (!mail && !drive)} onClick={() => void connect('google')}>Connect or reconnect Google</Button><Button variant="secondary" disabled={busy || !clientId.trim() || (!mail && !calendar)} onClick={() => void connect('microsoft')}>Connect or reconnect Microsoft</Button></div>
      {(['google', 'microsoft', 'calendar'] as const).filter(name => state[name].connected).map(integration => <Button key={integration} variant="secondary" disabled={busy} onClick={() => void act('integration-remove', {integration})}>Remove {integration} from configuration</Button>)}
      <p>Removing a connection here disables its tools after saving. Revoke provider consent separately to invalidate tokens at the provider.</p>
    </>}
  </section>;
}
