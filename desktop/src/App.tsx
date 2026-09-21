import { GitPanel } from "./GitPanel.js";
import { useEffect, useRef, useState } from "react";
import type { DesktopContext, DesktopProject } from "./bridge.js";
import type { HarnessClientRun, HarnessClientSession } from "../../src/client-contract.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { Conversation } from "./Conversation.js";
import { applyActivityPage, emptyActivity } from "./activity.js";
import { Navigation } from "./Navigation.js";
import { TaskPanel } from "./TaskPanel.js";
const isRunning = (run: HarnessClientRun | undefined) => Boolean(run && ["created", "running", "queued", "cancel_requested"].includes(run.status));
const command = async (key: string, value: Record<string, unknown>) => { const result = await window.harness.command(key, value); if (!result.ok) throw new Error(result.error.code); return result.data; };

export function App() {
    const [projects, setProjects] = useState<DesktopProject[]>([]), [context, setContext] = useState<DesktopContext>();
    const [sessions, setSessions] = useState<HarnessClientSession[]>([]), [session, setSession] = useState<HarnessClientSession>();
    const [run, setRun] = useState<HarnessClientRun>(), [activity, setActivity] = useState(emptyActivity), [prompt, setPrompt] = useState("");
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [ready, setReady] = useState(false), [disconnected, setDisconnected] = useState(false), [reconcileRequired, setReconcileRequired] = useState(false);
    const generation = useRef(0), activityRef = useRef(emptyActivity()), activeRun = useRef<string | undefined>(undefined), submitting = useRef(new Set<string>());
    const previousRuns = useRef<Set<string> | undefined>(undefined);
    const refreshProjects = async () => setProjects(await window.harness.projects());
    const refreshSessions = async (key: string) => { const data = await command(key, { method: "session.list" }); if (data.kind !== "sessions") throw new Error(); return data.sessions; };
    const reset = () => { generation.current++; setSession(undefined); setRun(undefined); setActivity(emptyActivity()); activityRef.current = emptyActivity(); setBusy(false); setPrompt(""); activeRun.current = undefined; previousRuns.current = undefined; setError(""); setDisconnected(false); setReconcileRequired(false); return generation.current; };
    const selecting = useRef(false);
    async function selectProject(open: () => Promise<DesktopContext | null>) {
        if (selecting.current) return; selecting.current = true; setLoading(true); setError("");
        let epoch = generation.current;
        try { const selected = await open(); if (selected) { epoch = reset(); setContext(selected); setSessions([]); const items = await refreshSessions(selected.project.key); if (epoch !== generation.current) return; setSessions(items); } await refreshProjects(); }
        catch { if (epoch === generation.current) setError("No se pudo abrir el repositorio. Comprobá que existe, que es un repositorio Git y que su servicio está disponible. Elegí otro proyecto o reintentá."); }
        finally { selecting.current = false; if (epoch === generation.current) { setLoading(false); setReady(true); } }
    }
    useEffect(() => { void selectProject(() => window.harness.initialProject()); return () => { generation.current++; }; }, []);
    async function selectSession(id: string) {
        if (!context) return; const key = context.project.key, epoch = reset(); setLoading(true);
        try {
            const data = await command(key, { method: "session.get", sessionId: id }); if (data.kind !== "session") throw new Error();
            const last = data.session.runs.at(-1); const loaded = last ? await command(key, { method: "run.get", sessionId: id, runId: last.runId }) : undefined;
            if (epoch !== generation.current) return;
            if (loaded?.kind === "run") { setRun(loaded.run); activeRun.current = loaded.run.runId; setBusy(isRunning(loaded.run)); }
            setSession(data.session); setSessions(items => items.map(item => item.sessionId === id ? data.session : item));
        } catch { if (epoch === generation.current) setError("No se pudo recuperar la conversación. Actualizá la lista o seleccioná otra sesión."); }
        finally { if (epoch === generation.current) setLoading(false); }
    }
    async function createSession() {
        if (!context || loading) return; const key = context.project.key, epoch = reset(); setLoading(true);
        try { const data = await command(key, { method: "session.create", idempotencyKey: crypto.randomUUID() }); if (data.kind !== "session") throw new Error(); const items = await refreshSessions(key); if (epoch !== generation.current) return; setSessions(items); setSession(data.session); }
        catch { if (epoch === generation.current) setError("No se pudo crear la conversación. Actualizá la lista antes de reintentar."); }
        finally { if (epoch === generation.current) setLoading(false); }
    }
    useEffect(() => {
        if (!context || !session) return; const key = context.project.key, id = session.sessionId, epoch = generation.current; let stopped = false, timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const page = await window.harness.events(key, id, activityRef.current.cursor); if (stopped || epoch !== generation.current) return;
                setDisconnected(false); const next = applyActivityPage(activityRef.current, page); activityRef.current = next; setActivity(next);
                for (const runId of next.order) if (!previousRuns.current?.has(runId)) activeRun.current = runId;
                if ((page.cursorExpired || page.events.some(e => e.activity.type === "checkpoint")) && activeRun.current) { const current = await command(key, { method: "run.get", sessionId: id, runId: activeRun.current }); if (stopped || epoch !== generation.current) return; if (current.kind === "run") { setRun(current.run); setSessions(items => items.map(item => item.sessionId === id ? { ...current.session, runs: current.session.runs.map(ref => ref.runId === current.run.runId ? { ...ref, status: current.run.status as typeof ref.status } : ref) } : item)); setBusy(isRunning(current.run) || submitting.current.has(`${key}:${id}`)); } }
            } catch { if (!stopped && epoch === generation.current) setDisconnected(true); }
            if (!stopped) timer = setTimeout(poll, 100);
        }; void poll(); return () => { stopped = true; clearTimeout(timer); };
    }, [context?.project.key, session?.sessionId]);
    async function start(value: string) {
        if (!context || !session || !value.trim() || busy || loading || reconcileRequired || disconnected) return;
        const key = context.project.key, id = session.sessionId, operation = `${key}:${id}`, epoch = generation.current;
        if (submitting.current.has(operation)) return; submitting.current.add(operation); previousRuns.current = new Set(session.runs.map(r => r.runId)); setBusy(true); setError(""); setRun(undefined); activeRun.current = undefined;
        try {
            const current = await command(key, { method: "session.get", sessionId: id }); if (current.kind !== "session") throw new Error();
            const result = await command(key, { method: "run.start", sessionId: id, expectedRevision: current.session.revision, idempotencyKey: crypto.randomUUID(), prompt: value });
            if (result.kind !== "run") throw new Error(); if (epoch !== generation.current) return; setRun(result.run); setSession(result.session); setPrompt(""); const items = await refreshSessions(key); if (epoch === generation.current) setSessions(items);
        } catch { if (epoch === generation.current) { setReconcileRequired(true); setError("No se pudo completar. Actualizá el estado antes de volver a enviar."); } }
        finally { submitting.current.delete(operation); if (epoch === generation.current) { setBusy(false); previousRuns.current = undefined; } }
    }
    async function cancel() {
        if (!context || !session || !activeRun.current) return; const key = context.project.key, id = session.sessionId, epoch = generation.current; try {
            const current = await command(key, { method: "run.get", sessionId: id, runId: activeRun.current }); if (current.kind !== "run") throw new Error();
            await command(key, { method: "run.cancel", sessionId: id, runId: current.run.runId, expectedRevision: current.run.revision, idempotencyKey: crypto.randomUUID() });
        } catch (error) { if (epoch === generation.current) setError(error instanceof Error && error.message === "BUSY" ? "La ejecución todavía tiene una reserva vigente. Esperá unos segundos, actualizá el estado y volvé a cancelar. Cancelar no revierte los cambios ya realizados." : "La cancelación recibió un conflicto. Actualizá el estado actual."); }
    }
    return <main data-ready={ready} data-project-key={context?.project.key} data-session-id={session?.sessionId}>
        <Navigation projects={projects} context={context} sessions={sessions} selectedSession={session?.sessionId} loading={loading} open={() => void selectProject(() => window.harness.chooseProject())} selectProject={key => void selectProject(() => window.harness.openProject(key))} selectSession={id => void selectSession(id)} create={() => void createSession()} />
        <section><header><div><span className="eyebrow">{context?.project.name ?? "TU ESPACIO DE TRABAJO"}</span><h1>{session?.title ?? (session ? "Nueva conversación" : "Proyectos y conversaciones")}</h1></div>{context?.fixture ? <span className="badge">Modelo offline</span> : null}</header>
            <div className="conversation" aria-busy={loading}>{context ? <GitPanel key={`git:${context.project.key}`} projectKey={context.project.key} disabled={loading} /> : null}{context ? <TaskPanel key={context.project.key} context={context} disabled={loading} open={id => selectProject(() => window.harness.openTask(id))} removed={async task => { if (context.task?.id === task.id) await selectProject(() => window.harness.openProject(task.sourceProjectKey)); }} /> : null}<div className="welcome"><span className="symbol">◈</span><h2>{loading ? "Recuperando estado…" : !context ? "Abrí un repositorio para empezar." : !session ? "Elegí una conversación o creá una nueva." : "¿Qué querés resolver?"}</h2><p>{context?.project.workspace ?? "Tus conversaciones y el estado de las tareas permanecen separados por proyecto."}</p></div>
                <Conversation key={session?.sessionId ?? "empty"} activity={activity} projectKey={context?.project.key} sessionId={session?.sessionId} />{context && session && run?.status === "waiting_approval" ? <ReviewPanel key={`${context.project.key}:${session.sessionId}:${run.runId}:${run.revision}`} projectKey={context.project.key} sessionId={session.sessionId} runId={run.runId} revision={run.revision} /> : null}{run ? <p role="status" className="status">Estado: {run.status} · {run.runId}</p> : null}
                {disconnected ? <div role="alert" className="error"><p>Conexión interrumpida. Reintentando la lectura del estado guardado.</p><button type="button" className="secondary" data-action="reconnect-project" disabled={loading} onClick={() => { if (context) void selectProject(() => window.harness.openProject(context.project.key)); }}>Reabrir proyecto</button></div> : null}
                {error ? <div role="alert" className="error"><p>{error}</p><button className="secondary" data-action="retry" onClick={() => { if (context && session) void selectSession(session.sessionId); else if (context) void selectProject(() => window.harness.openProject(context.project.key)); else void refreshProjects().catch(() => setError("No se pudo leer el índice de proyectos.")); }}>Actualizar estado</button></div> : null}</div>
            <footer><form onSubmit={event => { event.preventDefault(); void start(prompt); }}><label htmlFor="prompt">Mensaje</label><textarea id="prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={!session || loading} placeholder="Describí la tarea…" maxLength={64000} /><div className="actions"><button type="submit" data-action="start" disabled={!session || busy || loading || reconcileRequired || disconnected || !prompt.trim()}>Enviar ↗</button>{context?.fixture ? <button type="button" className="secondary" data-action="wait" disabled={!session || busy || reconcileRequired || disconnected} onClick={() => void start("wait-for-cancel")}>Probar espera</button> : null}<button type="button" className="secondary" data-action="cancel" disabled={(!busy && run?.status !== "waiting_approval") || !activeRun.current} onClick={() => void cancel()}>Cancelar</button><button type="button" className="secondary" disabled={!session || loading} onClick={() => { if (session) void selectSession(session.sessionId); }}>Actualizar conversación</button></div></form></footer>
        </section></main>;
}
