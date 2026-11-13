import { useEffect, useRef, useState } from 'react';
import { ChatRoot, Message } from '@zhivex-ai/react/components';
import { ChatCircle, Plus, Stop } from '@phosphor-icons/react';
import type { Snapshot, Review } from './api';
import { RunOutput } from './RunOutput';

type Session = Snapshot['sessions'][number];
const finished = (status: string) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);
const label = (status: string) => ({ running: 'Trabajando…', queued: 'Preparando…', pending: 'Preparando…', waiting_approval: 'Esperando tu aprobación', cancelled: 'Tarea detenida', failed: 'No se pudo completar', timed_out: 'Se agotó el tiempo' }[status] ?? 'Procesando…');
const labels = { user: 'Vos', assistant: 'Assistant', message: 'mensaje' };
const renderers = { text: ({ part }: { part: { text: string } }) => <RunOutput text={part.text}/> };
const title = (session: Session) => session.title && session.title !== 'Conversación web' ? session.title : session.runs.find(run => run.prompt)?.prompt ?? session.title ?? 'Conversación';

export function Conversations({ sessions, activeSession, busy, select, action, openReview }: {
  sessions: Session[]; activeSession?: Session; busy: boolean;
  select(id: string | null): void;
  action(route: string, data: unknown): Promise<unknown>;
  openReview(item: { sessionId: string; review: Review }): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const last = activeSession?.runs.at(-1);
  useEffect(() => { follow.current = true; }, [activeSession?.sessionId]);
  useEffect(() => {
    if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [activeSession?.sessionId, activeSession?.runs.length, last?.output, last?.status]);
  return <div className="conversation-layout">
    <aside className="chat-history" aria-label="Historial de conversaciones">
      <button className="new-chat" disabled={busy} onClick={() => select(null)}><Plus size={18}/>Nueva conversación</button>
      <div className="history-items">{sessions.map(session => <button key={session.sessionId} disabled={busy} className={`history-item ${activeSession?.sessionId === session.sessionId ? 'selected' : ''}`} aria-current={activeSession?.sessionId === session.sessionId ? 'true' : undefined} onClick={() => select(session.sessionId)}>
        <ChatCircle size={18}/><span><strong>{title(session)}</strong><small>{session.runs.at(-1)?.output || label(session.runs.at(-1)?.status ?? 'pending')}</small></span>
      </button>)}</div>
    </aside>
    <ChatRoot className="assistant-chat" label="Conversación con Assistant" theme="light">
      <header className="chat-heading"><span className="chat-avatar"><ChatCircle size={22}/></span><div><h2>{activeSession ? title(activeSession) : 'Nueva conversación'}</h2><p>Assistant · Tu asistente personal</p></div></header>
      <div className="chat-messages" ref={viewport} onScroll={() => { const el = viewport.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {!activeSession?.runs.length ? <div className="empty chat-empty"><ChatCircle size={40}/><h2>¿En qué te puedo ayudar?</h2><p>Escribí una idea, consultá tu agenda o empecemos una tarea.</p></div> : activeSession.runs.map(run => <div className="chat-turn" key={run.runId}>
          {run.prompt ? <Message message={{ id: `${run.runId}-user`, role: 'user', parts: [{ type: 'text', text: run.prompt }], createdAt: 0, status: 'complete' }} labels={labels} renderers={renderers} showActions={false} showStatus={false}/> : null}
          <div className="assistant-reply"><Message message={{ id: run.runId, role: 'assistant', parts: [{ type: 'text', text: run.output }], createdAt: 0, status: 'complete' }} labels={labels} renderers={renderers} showActions={false} showStatus={false}/>
            {run.review ? <button className="primary" onClick={() => openReview({sessionId: activeSession.sessionId, review: run.review!})}>Revisar acción</button> : null}
            {run.status !== 'completed' ? <div className={`run-activity ${run.status === 'waiting_approval' ? 'awaiting' : finished(run.status) ? 'settled' : 'working'}`}><span className="run-activity-label" role="status">{!finished(run.status) && run.status !== 'waiting_approval' ? <span className="activity-dots" aria-hidden="true"><i/><i/><i/></span> : null}{cancelling === run.runId ? 'Deteniendo…' : label(run.status)}</span>{!finished(run.status) ? <button className="run-stop" disabled={cancelling === run.runId} aria-label="Detener tarea" onClick={async () => { setCancelling(run.runId); try { await action('cancel', {sessionId: activeSession.sessionId, runId: run.runId, key: crypto.randomUUID()}); } finally { setCancelling(null); } }}><Stop size={13} weight="fill"/>Detener</button> : null}</div> : null}
          </div>
        </div>)}
      </div>
    </ChatRoot>
  </div>;
}
