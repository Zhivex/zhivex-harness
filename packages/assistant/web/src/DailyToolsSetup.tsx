import MicrosoftSetup from './MicrosoftSetup';
import { useState } from 'react';
import type { SetupState } from './Setup';

export default function DailyToolsSetup({ state, busy, act }: { state: SetupState; busy: boolean; act(route: string, input: unknown): Promise<boolean> }) {
  const [daily, setDaily] = useState(Boolean(state.tools?.daily));
  const [proactive, setProactive] = useState(Boolean(state.tools?.proactive));
  const [github, setGithub] = useState(Boolean(state.tools?.github)), [account, setAccount] = useState(state.tools?.github?.account ?? '');
  const [githubEnv, setGithubEnv] = useState(state.tools?.github?.authorizationEnv ?? 'ZHIVEX_MCP_GITHUB_AUTH');
  const [web, setWeb] = useState(Boolean(state.tools?.web)), [webEnv, setWebEnv] = useState(state.tools?.web?.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY');
  const [mail, setMail] = useState(Boolean(state.google?.mail)), [drive, setDrive] = useState(Boolean(state.google?.drive));
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState(''), [saved, setSaved] = useState(false);
  return <div className="daily-tools-setup">
    <h2>Herramientas para tu día</h2>
    <p>Elegí qué podrá usar este agente. Las escrituras se revisan desde la conversación antes de ejecutarse.</p>
    <form onSubmit={async event => { event.preventDefault(); setSaved(false); if (await act('tools', { daily, proactive: daily && proactive, ...(github ? { github: { account, authorizationEnv: githubEnv } } : {}), ...(web ? { web: { apiKeyEnv: webEnv } } : {}) })) setSaved(true); }}>
      <fieldset disabled={busy || state.calendar.pending} onChange={() => setSaved(false)}>
        <legend>Capacidades</legend>
        <label className="check-label"><input type="checkbox" checked={daily} onChange={e => setDaily(e.target.checked)}/>Tareas, recordatorios y notas locales</label>
        {daily ? <label className="check-label"><input type="checkbox" checked={proactive} onChange={e => setProactive(e.target.checked)}/>Configurar avisos proactivos y seguimientos desde el chat</label> : null}
        <p>Guardá pendientes, consultá notas y recibí avisos en esta web o en tu Telegram vinculado. Assistant debe permanecer abierto.</p>
        <label className="check-label"><input type="checkbox" checked={github} onChange={e => setGithub(e.target.checked)}/>GitHub · issues, PR y CI de lectura</label>
        {github ? <><label className="field">Cuenta de GitHub<input required value={account} onChange={e => setAccount(e.target.value)} maxLength={100}/></label><label className="field">Variable de autorización<input required value={githubEnv} onChange={e => setGithubEnv(e.target.value)} pattern="ZHIVEX_MCP_[A-Z0-9_]+"/></label><p>La variable del host debe contener «Bearer» seguido del token de esa cuenta. Se verifica la presencia; el acceso se comprueba al usar GitHub.</p></> : null}
        <label className="check-label"><input type="checkbox" checked={web} onChange={e => setWeb(e.target.checked)}/>Búsqueda web con Brave · cualquier modelo con herramientas</label>
        {web ? <><label className="field">Variable de la clave Brave<input required value={webEnv} onChange={e => setWebEnv(e.target.value)} pattern="[A-Z][A-Z0-9_]+"/></label><p>Usa la cuota de tu cuenta Brave Search. La clave se lee del entorno del host.</p></> : null}
        <button>Guardar herramientas</button>
      </fieldset>
      {saved ? <p role="status">Herramientas guardadas para este agente.</p> : null}
    </form>
    <MicrosoftSetup state={state} busy={busy} act={act}/>
    <h3>Correo y documentos de Google</h3>
    <p>Autorización independiente de Calendar. Gmail puede leer correo y crear borradores; no envía mensajes. Drive permite buscar y leer documentos de texto.</p>
    {state.google?.connected ? <p role="status">Conectado: {state.google.email} · {state.google.mail ? 'Gmail ' : ''}{state.google.drive ? 'Drive' : ''}</p> : null}
    <form onSubmit={async event => { event.preventDefault(); if (await act('google', { mail, drive, ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) })) setClientSecret(''); }}>
      <fieldset disabled={busy || state.calendar.pending}>
        <legend>Permisos de Google</legend>
        <label className="check-label"><input type="checkbox" checked={mail} onChange={e => setMail(e.target.checked)}/>Gmail: lectura y borradores</label>
        <label className="check-label"><input type="checkbox" checked={drive} onChange={e => setDrive(e.target.checked)}/>Drive: lectura</label>
        <label className="field">Client ID de Google{state.calendar.available ? ' · opcional, configurado en el host' : ''}<input required={!state.calendar.available} value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off"/></label>
        <label className="field">Client secret · si tu cliente lo requiere<input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="new-password"/></label>
        <button disabled={!mail && !drive}>Autorizar en Google</button>
      </fieldset>
    </form>
  </div>;
}
