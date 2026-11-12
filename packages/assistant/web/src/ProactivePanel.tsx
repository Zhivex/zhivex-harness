import { useState } from 'react';
import { api } from './api';

interface Policy {
  enabled: boolean; timeZone: string; channel: 'web' | 'telegram'; calendar: boolean; tasks: boolean; replies: boolean;
  quietStart: string; quietEnd: string; maxPerDay: number; bufferMinutes: number;
}
export interface ProactiveData {
  policy: Policy | null; sources: { calendar: boolean; replies: string[] };
  health: { source: string; status: string; checkedAt: number }[];
  alerts: { id: string; text: string; status: string; channel: string }[];
  watches: { id: string; title: string; expected_from: string; status: string; due_at: number }[];
}
const statuses: Record<string, string> = { available: 'Disponible', delivered: 'Entregado', sending: 'Enviando', uncertain: 'Entrega incierta; no se reenviará', resolved: 'Resuelto', dismissed: 'Descartado', expired: 'Vencido', waiting: 'Esperando', replied: 'Respuesta detectada', cancelled: 'Cancelado' };
export default function ProactivePanel({ data, refresh }: { data: ProactiveData; refresh(): Promise<void> }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const act = async (route: string, input: unknown) => {
    setBusy(true); setError('');
    try { await api(`proactive/${route}`, input); await refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  return <section aria-label="Avisos proactivos">
    <h3>Avisos proactivos · {data.policy?.enabled ? 'Activos' : 'Pausados'}</h3>
    <p>Revisa conflictos en las próximas 24 horas, tareas por vencer y respuestas que elegiste seguir. Assistant debe permanecer abierto. No modifica tu calendario ni envía correos.</p>
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={busy} onClick={() => setEditing(!editing)}>{editing ? 'Cerrar configuración' : 'Configurar avisos'}</button>
    {data.policy?.enabled ? <button disabled={busy} onClick={() => void act('policy', { ...data.policy, enabled: false })}>Pausar avisos</button> : null}
    {editing ? <PolicyEditor key={JSON.stringify(data.policy)} value={data.policy} busy={busy} save={async policy => { if (await act('policy', policy)) setEditing(false); }}/> : null}
    {!data.sources.calendar ? <p>Conflictos: conectá un calendario para habilitar la detección.</p> : null}
    {data.health.some(item => item.status === 'unavailable') ? <p role="status">Hay fuentes que no se pudieron consultar. Los avisos pueden estar incompletos; se volverá a intentar en la próxima revisión.</p> : null}
    <h4>Avisos recientes</h4>
    {data.alerts.length ? <ul>{data.alerts.map(alert => <li key={alert.id}><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{alert.text}</p><p>{statuses[alert.status] ?? alert.status} · {alert.channel === 'web' ? 'Esta web' : 'Telegram'}</p>{alert.status === 'available' ? <button disabled={busy} onClick={() => void act('dismiss', { alertId: alert.id })}>Descartar aviso</button> : null}</li>)}</ul> : <p>Todavía no hay avisos.</p>}
    <h4>Respuestas pendientes</h4>
    <p>En agentes con herramientas proactivas, pedí en el chat: «Seguí la respuesta de esta persona en este hilo y avisame si no contesta antes de mañana a las 15:00». Se revisan el hilo, el remitente y el plazo antes de guardar.</p>
    {data.watches.length ? <ul>{data.watches.map(watch => <li key={watch.id}><strong>{watch.title}</strong><p>{watch.expected_from} · {statuses[watch.status] ?? watch.status} · {new Intl.DateTimeFormat('es', { timeZone: data.policy?.timeZone ?? 'UTC', dateStyle: 'short', timeStyle: 'short' }).format(watch.due_at)}</p>{watch.status === 'waiting' ? <button disabled={busy} onClick={() => void act('cancel-watch', { watchId: watch.id })}>Dejar de seguir</button> : null}</li>)}</ul> : <p>No hay seguimientos registrados.</p>}
  </section>;
}
function PolicyEditor({ value, busy, save }: { value: Policy | null; busy: boolean; save(value: Policy): Promise<void> }) {
  const [policy, setPolicy] = useState<Policy>(() => value ?? { enabled: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, channel: 'web', calendar: true, tasks: true, replies: true, quietStart: '22:00', quietEnd: '08:00', maxPerDay: 5, bufferMinutes: 0 });
  return <form onSubmit={event => { event.preventDefault(); void save(policy); }}>
    <fieldset disabled={busy}><legend>Preferencias de avisos</legend>
      <label className="check-label"><input type="checkbox" checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })}/>Activar avisos</label>
      {(['calendar', 'tasks', 'replies'] as const).map(key => <label className="check-label" key={key}><input type="checkbox" checked={policy[key]} onChange={e => setPolicy({ ...policy, [key]: e.target.checked })}/>{{ calendar: 'Conflictos de agenda', tasks: 'Tareas por vencer', replies: 'Respuestas pendientes' }[key]}</label>)}
      <label className="field">Zona horaria<input required value={policy.timeZone} onChange={e => setPolicy({ ...policy, timeZone: e.target.value })}/></label>
      <label className="field">Dónde avisar<select value={policy.channel} onChange={e => setPolicy({ ...policy, channel: e.target.value as Policy['channel'] })}><option value="web">Esta web</option><option value="telegram">Telegram vinculado</option></select></label>
      <label className="field">Silencio desde<input type="time" required value={policy.quietStart} onChange={e => setPolicy({ ...policy, quietStart: e.target.value })}/></label>
      <label className="field">Silencio hasta<input type="time" required value={policy.quietEnd} onChange={e => setPolicy({ ...policy, quietEnd: e.target.value })}/></label>
      <p>Usá la misma hora para desactivar el silencio. Los avisos se vuelven a evaluar al finalizarlo.</p>
      <label className="field">Máximo de avisos por día<input type="number" required min={1} max={20} value={policy.maxPerDay} onChange={e => setPolicy({ ...policy, maxPerDay: Number(e.target.value) })}/></label>
      <label className="field">Margen entre reuniones (minutos)<input type="number" required min={0} max={120} value={policy.bufferMinutes} onChange={e => setPolicy({ ...policy, bufferMinutes: Number(e.target.value) })}/></label>
      <button>Guardar preferencias</button>
    </fieldset>
  </form>;
}
