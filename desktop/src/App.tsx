import {
  ArrowUp,
  ArrowUpRight,
  Code2,
  FolderSearch,
  PanelLeft,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { ModelSelector } from "./ModelSelector.js";
import { GitPanel } from "./GitPanel.js";
import { useEffect, useRef, useState } from "react";
import type {
  DesktopContext,
  DesktopProject,
  DesktopProvider,
} from "./bridge.js";
import type {
  HarnessClientRun,
  HarnessClientSession,
} from "../../src/client-contract.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { Conversation } from "./Conversation.js";
import { applyActivityPage, emptyActivity } from "./activity.js";
import { Navigation } from "./Navigation.js";
import { TaskPanel } from "./TaskPanel.js";
const isRunning = (run: HarnessClientRun | undefined) =>
  Boolean(
    run &&
      ["created", "running", "queued", "cancel_requested"].includes(run.status),
  );
const command = async (key: string, value: Record<string, unknown>) => {
  const result = await window.harness.command(key, value);
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
};

export function App() {
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [modelEditing, setModelEditing] = useState(false);
  const [providers, setProviders] = useState<DesktopProvider[]>([]);
  const [projects, setProjects] = useState<DesktopProject[]>([]),
    [context, setContext] = useState<DesktopContext>();
  const [sessions, setSessions] = useState<HarnessClientSession[]>([]),
    [session, setSession] = useState<HarnessClientSession>();
  const [run, setRun] = useState<HarnessClientRun>(),
    [activity, setActivity] = useState(emptyActivity),
    [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [disconnected, setDisconnected] = useState(false),
    [reconcileRequired, setReconcileRequired] = useState(false);
  const generation = useRef(0),
    activityRef = useRef(emptyActivity()),
    activeRun = useRef<string | undefined>(undefined),
    submitting = useRef(new Set<string>());
  const previousRuns = useRef<Set<string> | undefined>(undefined);
  const refreshProjects = async () =>
    setProjects(await window.harness.projects());
  const refreshSessions = async (key: string) => {
    const data = await command(key, { method: "session.list" });
    if (data.kind !== "sessions") throw new Error();
    return data.sessions;
  };
  const reset = () => {
    generation.current++;
    setSession(undefined);
    setRun(undefined);
    setActivity(emptyActivity());
    activityRef.current = emptyActivity();
    setBusy(false);
    setPrompt("");
    activeRun.current = undefined;
    previousRuns.current = undefined;
    setError("");
    setDisconnected(false);
    setReconcileRequired(false);
    return generation.current;
  };
  const selecting = useRef(false);
  async function selectProject(open: () => Promise<DesktopContext | null>) {
    if (selecting.current) return;
    selecting.current = true;
    setLoading(true);
    setError("");
    let epoch = generation.current;
    try {
      const selected = await open();
      if (selected) {
        epoch = reset();
        setContext(selected);
        setSessions([]);
        const items = await refreshSessions(selected.project.key);
        if (epoch !== generation.current) return;
        setSessions(items);
      }
      await refreshProjects();
    } catch {
      if (epoch === generation.current)
        setError(
          "No se pudo abrir el repositorio. Comprobá que existe, que es un repositorio Git y que su servicio está disponible. Elegí otro proyecto o reintentá.",
        );
    } finally {
      selecting.current = false;
      if (epoch === generation.current) {
        setLoading(false);
        setReady(true);
      }
    }
  }
  useEffect(() => {
    let cancelled = false;
    void window.harness
      .providers()
      .then((items) => {
        if (!cancelled) setProviders(items);
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "No se pudo cargar la lista de proveedores. Reabrí la aplicación.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    void selectProject(() => window.harness.initialProject());
    return () => {
      generation.current++;
    };
  }, []);
  async function credentialsChanged() {
    if (!context) return;
    const key = context.project.key,
      epoch = generation.current;
    setLoading(true);
    try {
      const next = await window.harness.openProject(key);
      if (epoch === generation.current) {
        setContext(next);
        setDisconnected(false);
      }
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  async function selectSession(id: string) {
    if (!context) return;
    const key = context.project.key,
      epoch = reset();
    setLoading(true);
    try {
      const data = await command(key, { method: "session.get", sessionId: id });
      if (data.kind !== "session") throw new Error();
      const last = data.session.runs.at(-1);
      const loaded = last
        ? await command(key, {
            method: "run.get",
            sessionId: id,
            runId: last.runId,
          })
        : undefined;
      if (epoch !== generation.current) return;
      if (loaded?.kind === "run") {
        setRun(loaded.run);
        activeRun.current = loaded.run.runId;
        setBusy(isRunning(loaded.run));
      }
      setSession(data.session);
      setSessions((items) =>
        items.map((item) => (item.sessionId === id ? data.session : item)),
      );
    } catch {
      if (epoch === generation.current)
        setError(
          "No se pudo recuperar la conversación. Actualizá la lista o seleccioná otra sesión.",
        );
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  async function createSession() {
    if (!context || loading) return;
    const key = context.project.key,
      epoch = reset();
    setLoading(true);
    try {
      const data = await command(key, {
        method: "session.create",
        idempotencyKey: crypto.randomUUID(),
      });
      if (data.kind !== "session") throw new Error();
      const items = await refreshSessions(key);
      if (epoch !== generation.current) return;
      setSessions(items);
      setSession(data.session);
    } catch {
      if (epoch === generation.current)
        setError(
          "No se pudo crear la conversación. Actualizá la lista antes de reintentar.",
        );
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!context || !session || modelEditing) return;
    const key = context.project.key,
      id = session.sessionId,
      epoch = generation.current;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const page = await window.harness.events(
          key,
          id,
          activityRef.current.cursor,
        );
        if (stopped || epoch !== generation.current) return;
        setDisconnected(false);
        const next = applyActivityPage(activityRef.current, page);
        activityRef.current = next;
        setActivity(next);
        for (const runId of next.order)
          if (!previousRuns.current?.has(runId)) activeRun.current = runId;
        if (
          (page.cursorExpired ||
            page.events.some((e) => e.activity.type === "checkpoint")) &&
          activeRun.current
        ) {
          const current = await command(key, {
            method: "run.get",
            sessionId: id,
            runId: activeRun.current,
          });
          if (stopped || epoch !== generation.current) return;
          if (current.kind === "run") {
            setRun(current.run);
            setSessions((items) =>
              items.map((item) =>
                item.sessionId === id
                  ? {
                      ...current.session,
                      runs: current.session.runs.map((ref) =>
                        ref.runId === current.run.runId
                          ? {
                              ...ref,
                              status: current.run.status as typeof ref.status,
                            }
                          : ref,
                      ),
                    }
                  : item,
              ),
            );
            setBusy(
              isRunning(current.run) || submitting.current.has(`${key}:${id}`),
            );
          }
        }
      } catch {
        if (!stopped && epoch === generation.current) setDisconnected(true);
      }
      if (!stopped) timer = setTimeout(poll, 100);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [context?.project.key, session?.sessionId, modelEditing]);
  async function start(value: string) {
    if (
      !context ||
      !session ||
      !value.trim() ||
      context.credentialConfigured === false ||
      modelEditing ||
      busy ||
      loading ||
      reconcileRequired ||
      disconnected
    )
      return;
    const key = context.project.key,
      id = session.sessionId,
      operation = `${key}:${id}`,
      epoch = generation.current;
    if (submitting.current.has(operation)) return;
    submitting.current.add(operation);
    previousRuns.current = new Set(session.runs.map((r) => r.runId));
    setBusy(true);
    setError("");
    setRun(undefined);
    activeRun.current = undefined;
    try {
      const current = await command(key, {
        method: "session.get",
        sessionId: id,
      });
      if (current.kind !== "session") throw new Error();
      const result = await command(key, {
        method: "run.start",
        sessionId: id,
        expectedRevision: current.session.revision,
        idempotencyKey: crypto.randomUUID(),
        prompt: value,
      });
      if (result.kind !== "run") throw new Error();
      if (epoch !== generation.current) return;
      setRun(result.run);
      setSession(result.session);
      setPrompt("");
      const items = await refreshSessions(key);
      if (epoch === generation.current) setSessions(items);
    } catch {
      if (epoch === generation.current) {
        setReconcileRequired(true);
        setError(
          "No se pudo completar. Actualizá el estado antes de volver a enviar.",
        );
      }
    } finally {
      submitting.current.delete(operation);
      if (epoch === generation.current) {
        setBusy(false);
        previousRuns.current = undefined;
      }
    }
  }
  async function cancel() {
    if (!context || !session || !activeRun.current) return;
    const key = context.project.key,
      id = session.sessionId,
      epoch = generation.current;
    try {
      const current = await command(key, {
        method: "run.get",
        sessionId: id,
        runId: activeRun.current,
      });
      if (current.kind !== "run") throw new Error();
      await command(key, {
        method: "run.cancel",
        sessionId: id,
        runId: current.run.runId,
        expectedRevision: current.run.revision,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      if (epoch === generation.current)
        setError(
          error instanceof Error && error.message === "BUSY"
            ? "La ejecución todavía tiene una reserva vigente. Esperá unos segundos, actualizá el estado y volvé a cancelar. Cancelar no revierte los cambios ya realizados."
            : "La cancelación recibió un conflicto. Actualizá el estado actual.",
        );
    }
  }
  const canSend = Boolean(
    session &&
      context?.credentialConfigured !== false &&
      !modelEditing &&
      !busy &&
      !loading &&
      !reconcileRequired &&
      !disconnected &&
      prompt.trim(),
  );
  return (
    <main
      className={sidebarHidden ? "sidebar-hidden" : ""}
      data-ready={ready}
      data-project-key={context?.project.key}
      data-session-id={session?.sessionId}
    >
      <Navigation
        hidden={sidebarHidden}
        credentialsChanged={credentialsChanged}
        providers={providers}
        projects={projects}
        context={context}
        sessions={sessions}
        selectedSession={session?.sessionId}
        loading={loading}
        open={() => void selectProject(() => window.harness.chooseProject())}
        selectProject={(key) =>
          void selectProject(() => window.harness.openProject(key))
        }
        selectSession={(id) => void selectSession(id)}
        create={() => void createSession()}
      />
      <section className="chat-workspace">
        <header className="workspace-header">
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-label={
              sidebarHidden ? "Mostrar navegación" : "Ocultar navegación"
            }
            aria-controls="sidebar"
            aria-expanded={!sidebarHidden}
            onClick={() => setSidebarHidden((value) => !value)}
          >
            <PanelLeft size={19} />
          </button>
          <div className="workspace-title">
            <span className="eyebrow">
              {context?.project.name ?? "TU ESPACIO DE TRABAJO"}
            </span>
            <h1>
              {session?.title ??
                (session ? "Nueva conversación" : "Construí con Harness")}
            </h1>
          </div>
          <div className="header-actions">
            {context?.fixture ? (
              <span className="badge">Modelo offline</span>
            ) : null}
            <button
              type="button"
              className="icon-button"
              aria-label="Actualizar conversación"
              title="Actualizar conversación"
              disabled={!session || loading}
              onClick={() => {
                if (session) void selectSession(session.sessionId);
              }}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        {context ? (
          <div className="workspace-tools">
            <GitPanel
              key={`git:${context.project.key}`}
              projectKey={context.project.key}
              disabled={loading}
            />
            <TaskPanel
              key={context.project.key}
              context={context}
              disabled={loading}
              open={(id) => selectProject(() => window.harness.openTask(id))}
              removed={async (task) => {
                if (context.task?.id === task.id)
                  await selectProject(() =>
                    window.harness.openProject(task.sourceProjectKey),
                  );
              }}
            />
          </div>
        ) : null}
        <div className="conversation" aria-busy={loading}>
          {!activity.order.length ? (
            <div className="welcome">
              <span className="welcome-mark">
                <Sparkles size={28} aria-hidden="true" />
              </span>
              <span className="eyebrow">DE LA IDEA AL CÓDIGO</span>
              <h2>
                {loading ? (
                  "Preparando tu espacio…"
                ) : !context ? (
                  "Tu próximo proyecto empieza acá."
                ) : !session ? (
                  "Una nueva idea. Una nueva conversación."
                ) : (
                  <>
                    ¿Qué vamos a <em>construir hoy?</em>
                  </>
                )}
              </h2>
              <p>
                {!context
                  ? "Abrí un repositorio para empezar. Investigá, implementá y revisá con tu modelo favorito."
                  : "Explorá tu código, convertí ideas en cambios y revisá cada paso antes de aprobarlo."}
              </p>
              {!context ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() =>
                    void selectProject(() => window.harness.chooseProject())
                  }
                >
                  Abrir repositorio{" "}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </button>
              ) : !session ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void createSession()}
                >
                  Nueva conversación{" "}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </button>
              ) : (
                <div className="suggestions">
                  {[
                    {
                      icon: FolderSearch,
                      title: "Explorar el proyecto",
                      detail: "Entendé cómo está organizado",
                      prompt:
                        "Explorá la estructura de este repositorio y explicame sus componentes principales.",
                    },
                    {
                      icon: Code2,
                      title: "Implementar un cambio",
                      detail: "Dale forma a tu próxima idea",
                      prompt: "Quiero implementar un cambio en este proyecto: ",
                    },
                    {
                      icon: ShieldCheck,
                      title: "Revisar el código",
                      detail: "Encontrá mejoras y riesgos",
                      prompt:
                        "Revisá el código de este repositorio e identificá problemas concretos con evidencia. No modifiques archivos todavía.",
                    },
                  ].map((item) => (
                    <button
                      type="button"
                      className="suggestion"
                      key={item.title}
                      disabled={loading}
                      onClick={() => {
                        setPrompt(item.prompt);
                        promptInput.current?.focus();
                      }}
                    >
                      <item.icon size={19} aria-hidden="true" />
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                      <ArrowUpRight
                        className="suggestion-arrow"
                        size={15}
                        aria-hidden="true"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          <Conversation
            key={session?.sessionId ?? "empty"}
            activity={activity}
            projectKey={context?.project.key}
            sessionId={session?.sessionId}
          />
          {context && session && run?.status === "waiting_approval" ? (
            <ReviewPanel
              key={`${context.project.key}:${session.sessionId}:${run.runId}:${run.revision}`}
              projectKey={context.project.key}
              sessionId={session.sessionId}
              runId={run.runId}
              revision={run.revision}
            />
          ) : null}
          {run ? (
            <p role="status" className="status">
              Estado: {run.status} · {run.runId}
            </p>
          ) : null}
          {disconnected ? (
            <div role="alert" className="error">
              <p>
                Conexión interrumpida. Reintentando la lectura del estado
                guardado.
              </p>
              <button
                type="button"
                className="secondary"
                data-action="reconnect-project"
                disabled={loading}
                onClick={() => {
                  if (context)
                    void selectProject(() =>
                      window.harness.openProject(context.project.key),
                    );
                }}
              >
                Reabrir proyecto
              </button>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="error">
              <p>{error}</p>
              <button
                className="secondary"
                data-action="retry"
                onClick={() => {
                  if (context && session) void selectSession(session.sessionId);
                  else if (context)
                    void selectProject(() =>
                      window.harness.openProject(context.project.key),
                    );
                  else
                    void refreshProjects().catch(() =>
                      setError("No se pudo leer el índice de proyectos."),
                    );
                }}
              >
                Actualizar estado
              </button>
            </div>
          ) : null}
        </div>
        <footer className="composer-region">
          <div className="chat-composer">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void start(prompt);
              }}
            >
              <label className="sr-only" htmlFor="prompt">
                Tu mensaje
              </label>
              <textarea
                ref={promptInput}
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault();
                    if (canSend) void start(prompt);
                  }
                }}
                disabled={!session || loading}
                placeholder={
                  !session
                    ? "Creá una conversación para empezar…"
                    : "¿Qué tenés en mente?"
                }
                maxLength={64000}
              />
              <div className="composer-toolbar">
                <ModelSelector
                  key={`${context?.project.key ?? "empty"}:${context?.modelSelection?.provider ?? "openai"}:${context?.modelSelection?.model ?? providers.find((p) => p.id === "openai")?.defaultModel ?? ""}`}
                  context={context}
                  providers={providers}
                  editing={setModelEditing}
                  disabled={
                    loading ||
                    busy ||
                    run?.status === "waiting_approval" ||
                    reconcileRequired ||
                    disconnected
                  }
                  changed={(next) => {
                    setContext(next);
                    setDisconnected(false);
                    void refreshProjects();
                  }}
                />
                <div className="composer-actions">
                  {context?.fixture ? (
                    <button
                      type="button"
                      className="secondary fixture-action"
                      data-action="wait"
                      disabled={
                        !session || busy || reconcileRequired || disconnected
                      }
                      onClick={() => void start("wait-for-cancel")}
                    >
                      Probar espera
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-button cancel-run"
                    data-action="cancel"
                    aria-label="Cancelar ejecución"
                    title="Cancelar ejecución"
                    hidden={!busy && run?.status !== "waiting_approval"}
                    disabled={
                      (!busy && run?.status !== "waiting_approval") ||
                      !activeRun.current
                    }
                    onClick={() => void cancel()}
                  >
                    <Square size={17} />
                  </button>
                  <button
                    type="submit"
                    className="send-button"
                    data-action="start"
                    aria-label="Enviar mensaje"
                    title="Enviar mensaje"
                    disabled={!canSend}
                  >
                    <ArrowUp size={20} />
                  </button>
                </div>
              </div>
            </form>
          </div>
          <div className="composer-caption">
            {context?.credentialConfigured === false ? (
              <span className="credential-hint">
                Configurá la clave del proveedor en Credenciales para enviar
                mensajes.
              </span>
            ) : (
              <span>Enter para enviar · Shift + Enter para nueva línea</span>
            )}
            <span>{prompt.length.toLocaleString("es-AR")} / 64.000</span>
          </div>
        </footer>
      </section>
    </main>
  );
}
