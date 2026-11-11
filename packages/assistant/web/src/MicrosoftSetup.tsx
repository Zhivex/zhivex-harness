import { useState } from 'react';
import type { SetupState } from './Setup';

export default function MicrosoftSetup({ state, busy, act }: { state: SetupState; busy: boolean; act(route: string, input: unknown): Promise<boolean> }) {
  const [clientId, setClientId] = useState(state.microsoft?.clientId ?? '');
  const [tenantId, setTenantId] = useState(state.microsoft?.tenantId ?? '');
  const [mail, setMail] = useState(state.microsoft?.mail ?? true);
  const [calendar, setCalendar] = useState(state.microsoft?.calendar ?? !state.calendar.connected);
  const connected = state.microsoft?.connected;
  return <section className="microsoft-setup" aria-labelledby="microsoft-heading">
    <h3 id="microsoft-heading">Microsoft · Outlook empresarial</h3>
    <p>Conectá tu cuenta de trabajo para consultar correos, preparar borradores y usar tu calendario. Cada borrador y evento requiere tu aprobación.</p>
    {connected ? <p role="status">Conectado: {state.microsoft?.email} · {state.microsoft?.mail ? 'Correo y borradores ' : ''}{state.microsoft?.calendar ? 'Calendario' : ''}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void act('microsoft', { clientId: clientId.trim(), tenantId: tenantId.trim(), mail, calendar }); }}>
      <fieldset disabled={busy || state.calendar.pending}>
        <legend>Conexión de Microsoft</legend>
        <label className="field">Application (client) ID<input required value={clientId} onChange={e => setClientId(e.target.value)} readOnly={connected} placeholder="ID de aplicación de Entra" autoComplete="off"/></label>
        <label className="field">Directory (tenant) ID<input required value={tenantId} onChange={e => setTenantId(e.target.value)} readOnly={connected} placeholder="ID de tu organización" autoComplete="off"/></label>
        <label className="check-label"><input type="checkbox" checked={mail} disabled={connected} onChange={e => setMail(e.target.checked)}/>Outlook: leer correos y crear borradores</label>
        <label className="check-label"><input type="checkbox" checked={calendar} disabled={connected || state.calendar.connected} onChange={e => setCalendar(e.target.checked)}/>Calendario: consultar y crear eventos personales</label>
        {state.calendar.connected ? <p>Google Calendar ya es la agenda de este agente. Podés conectar solo el correo de Outlook.</p> : null}
        <button disabled={!mail && !calendar}>{connected ? 'Volver a autorizar Microsoft' : 'Autorizar en Microsoft'}</button>
        {connected ? <button type="button" onClick={() => void act('microsoft-disconnect', {})}>Desconectar Microsoft</button> : null}
      </fieldset>
    </form>
    <details><summary>Qué configurar en Entra ID</summary><ol>
      <li>Registrá una aplicación para cuentas de tu organización.</li>
      <li>En Authentication, agregá la plataforma Mobile and desktop applications con la URI <code>http://localhost/oauth/callback</code>.</li>
      <li>Agregá permisos delegados de Microsoft Graph: <code>User.Read</code>, <code>offline_access</code>, <code>Mail.ReadWrite</code> para correo y <code>Calendars.ReadWrite</code> para calendario. Solicitá consentimiento de IT si tu empresa lo exige.</li>
      <li>Copiá los IDs de aplicación y directorio en los campos de arriba. No necesitás un client secret.</li>
    </ol><p>Assistant no solicita Mail.Send. Crea borradores nuevos y eventos sin invitados; no envía correos ni invitaciones.</p></details>
  </section>;
}
