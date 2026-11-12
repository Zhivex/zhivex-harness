import ProactivePanel, { type ProactiveData } from './ProactivePanel';
import { useEffect, useState } from 'react';
import { api, isDemo } from './api';

interface DailyData {
  proactive?: ProactiveData;
  enabled: boolean; total?: number;
  tasks: { id: string; title: string; due_date: string | null }[];
  reminders: { id: string; text: string; due_at: number; time_zone: string; channel: string; status: string }[];
}
const labels: Record<string, string> = { pending: 'Programado', available: 'Aviso disponible', delivered: 'Entregado', uncertain: 'Entrega incierta · no se reenviará', expired: 'Vencido', cancelled: 'Cancelado', sending: 'Enviando' };
export default function DailyPanel() {
  const [data, setData] = useState<DailyData | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) return;
    let active = true, inFlight = false;
    const refresh = async () => {
      if (inFlight) return; inFlight = true;
      try { const next = await api<DailyData>('daily'); if (active) { setData(next); setError(''); } }
      catch (e) { if (active) setError((e as Error).message); }
      finally { inFlight = false; }
    };
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (isDemo || (data && !data.enabled)) return null;
  return <section className="card settings daily-panel" aria-label="Tareas y recordatorios">
    <h2>Tareas y recordatorios</h2>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Cargando pendientes…</p> : <>
      <p>Pedí en el chat crear o completar una tarea, guardar una nota o programar un recordatorio. Revisá la acción cuando Assistant la proponga.</p>
      <h3>Pendientes ({data.total ?? data.tasks.length})</h3>
      {data.tasks.length ? <ul>{data.tasks.map(task => <li key={task.id}>{task.title}{task.due_date ? ` · ${task.due_date}` : ''}</li>)}</ul> : <p>No hay tareas pendientes.</p>}
      {(data.total ?? 0) > data.tasks.length ? <p>Se muestran {data.tasks.length}. Consultá el resto en la conversación.</p> : null}
      {data.proactive ? <ProactivePanel data={data.proactive} refresh={async () => setData(await api<DailyData>('daily'))}/> : null}
      <h3>Recordatorios recientes</h3>
      {data.reminders.length ? <ul>{data.reminders.map(row => <li key={row.id}><strong>{row.text}</strong><p>{new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short', timeZone: row.time_zone }).format(row.due_at)} · {row.time_zone} · {row.channel === 'web' ? 'Esta web' : 'Telegram'} · {labels[row.status] ?? row.status}</p></li>)}</ul> : <p>No hay recordatorios. Los avisos necesitan que Assistant esté abierto.</p>}
    </>}
  </section>;
}
