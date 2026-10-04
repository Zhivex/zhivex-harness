import { useEffect, useRef, useState } from "react";
import { ChatRoot, Message } from "@zhivex-ai/react/components";
import { FileDiff } from "../../../desktop/src/FileDiff.js";
import {
  applyActivityPage,
  emptyActivity,
  type ConversationActivity,
} from "../../../desktop/src/activity.js";
import { action, context, reconnect } from "./api.js";
import { MessageMarkdown } from "./MessageMarkdown.js";
import type {
  WebContext,
  HarnessClientRun,
  HarnessClientSession,
  HarnessActivityPage,
  TicketedApprovalReview,
  WebModelChoice,
} from "./contracts.js";

type Sessions = {
  data: { kind: "sessions"; sessions: HarnessClientSession[] };
};
type Session = { data: { kind: "session"; session: HarnessClientSession } };
type Run = {
  data: { kind: "run"; session: HarnessClientSession; run: HarnessClientRun };
};
const key = () => crypto.randomUUID();
const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");
const active = (status: string) =>
  ["running", "created", "queued", "cancel_requested"].includes(status);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "WEB_REQUEST_FAILED";
const recovery: Record<string, string> = {
  WEB_MODEL_CHANGE_BUSY: "Finish or cancel all active and pending-approval runs in this workspace before changing model.",
  WEB_MODEL_NOT_CONFIGURED: "Configure this provider in the CLI first. Credential values are never entered here.",
  WEB_MODEL_SWITCH_FAILED: "The model change failed. Reconnect to inspect the host configuration before another action.",
  WEB_MODEL_UNAVAILABLE: "The host configuration is unavailable. Restart the local launcher and pair again.",
  WEB_PAIRING_REQUIRED:
    "Use the paired browser tab, or restart zhivex-code web to pair again.",
  WEB_REQUEST_FAILED:
    "Reconnect to read durable state before trying a new action.",
  REVISION_CONFLICT: "The run changed. Refresh its review before deciding.",
  REVIEW_REQUIRED:
    "Open a fresh review. A submitted decision is never replayed.",
  REVIEW_EXPIRED: "This review expired. Open a fresh review.",
  RUN_STATE_UNAVAILABLE:
    "The latest turn has no readable run state. Reconnect to inspect it; create a new session if it remains unavailable.",
  WEB_CREDENTIALS_REQUIRED:
    "Configure the existing CLI profile or launching environment, then restart.",
};

export function App() {
  const [modelChoices, setModelChoices] = useState<WebModelChoice[]>([]);
  const [modelChoice, setModelChoice] = useState("");
  const [modelError, setModelError] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [ctx, setContext] = useState<WebContext>();
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [sessions, setSessions] = useState<HarnessClientSession[]>([]);
  const [session, setSession] = useState<HarnessClientSession>();
  const [activity, setActivity] = useState<ConversationActivity>(emptyActivity);
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [run, setRun] = useState<HarnessClientRun>();
  const [runUnavailable, setRunUnavailable] = useState(false);
  const [review, setReview] = useState<TicketedApprovalReview>();
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState("");
  const inFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const reconnectInFlight = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const mutationEpoch = useRef(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [stateLoading, setStateLoading] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [reviewDeadline, setReviewDeadline] = useState(0);
  const focusPrompt = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef(new Map<string, string>());
  const [refresh, setRefresh] = useState(0);
  const selection = useRef({ workspaceKey: "", sessionId: "" });
  selection.current = { workspaceKey, sessionId: session?.sessionId ?? "" };
  useEffect(() => {
    if (focusPrompt.current && session && !stateLoading && !pending) {
      focusPrompt.current = false;
      promptInput.current?.focus();
    }
  }, [session, stateLoading, pending]);
  useEffect(() => {
    if (!review) return;
    reviewHeading.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review]);
  useEffect(() => {
    void context()
      .then((c) => {
        setContext(c);
        setWorkspaceKey(c.workspaces[0]?.key ?? "");
        setConnected(true);
      })
      .catch((e) => {
        setConnected(false);
        setError(errorText(e));
      });
  }, []);
  useEffect(() => {
    if (!workspaceKey) return;
    let stopped = false;
    setSessionsLoading(true);
    setSessions([]);
    setSession(undefined);
    setRun(undefined);
    setRunUnavailable(false);
    setReview(undefined);
    setActivity(emptyActivity());
    void action<Sessions>(workspaceKey, "sessions")
      .then((r) => {
        if (stopped) return;
        setSessions(r.data.sessions);
        setSessionsLoading(false);
        setConnected(true);
        const saved = localStorage.getItem(`zhivex-session:${workspaceKey}`);
        const chosen = r.data.sessions.find((s) => s.sessionId === saved) ?? r.data.sessions[0];
        setSession(chosen);
        setPrompt(drafts.current.get(`${workspaceKey}:${chosen?.sessionId ?? ""}`) ?? "");
      })
      .catch((e) => {
        if (!stopped) {
          setSessionsLoading(false);
          setConnected(false);
          setError(errorText(e));
        }
      });
    return () => {
      stopped = true;
    };
  }, [workspaceKey]);
  const sessionId = session?.sessionId;
  useEffect(() => {
    setReview(undefined);
    setRun(undefined);
    setRunUnavailable(false);
    const empty = emptyActivity();
    activityRef.current = empty;
    setActivity(empty);
    setStateLoading(Boolean(workspaceKey && sessionId));
  }, [workspaceKey, sessionId]);
  useEffect(() => {
    if (!workspaceKey || !sessionId) return;
    localStorage.setItem(`zhivex-session:${workspaceKey}`, sessionId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const epoch = mutationEpoch.current;
      const obsolete = () => stopped || epoch !== mutationEpoch.current;
      try {
        const page = await action<HarnessActivityPage>(workspaceKey, "events", {
          sessionId,
          after: activityRef.current.cursor,
        });
        if (obsolete()) return;
        const next = applyActivityPage(activityRef.current, page);
        activityRef.current = next;
        setActivity(next);
        const result = await action<Session>(workspaceKey, "session", {
          sessionId,
        });
        if (obsolete()) return;
        setSession(result.data.session);
        setSessions((previous) =>
          previous.map((s) =>
            s.sessionId === result.data.session.sessionId
              ? result.data.session
              : s,
          ),
        );
        const latest = result.data.session.runs.at(-1);
        if (latest) {
          if (latest.runId !== runRef.current?.runId) {
            setStateLoading(true);
            setRun(undefined);
          }
          try {
            const detail = await action<Run>(workspaceKey, "run", {
              sessionId,
              runId: latest.runId,
            });
            if (obsolete()) return;
            setRun(detail.data.run);
            setRunUnavailable(false);
          } catch (e) {
            if (obsolete()) return;
            if (errorText(e) !== "NOT_FOUND") throw e;
            setRun(undefined);
            setRunUnavailable(true);
            setReview(undefined);
            setError("RUN_STATE_UNAVAILABLE");
          }
        }
        setStateLoading(false);
        setConnected(true);

        timer = setTimeout(() => void poll(), page.hasMore ? 20 : 650);
      } catch (e) {
        if (obsolete()) return;
        setStateLoading(false);
        setConnected(false);
        setError(errorText(e));
        timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [workspaceKey, sessionId, refresh]);
  const loading = sessionsLoading || stateLoading || (!ctx && !error);
  const busy =
    runUnavailable ||
    Boolean(run && (active(run.status) || run.status === "waiting_approval"));
  const canMutate = Boolean(
    ctx &&
      workspaceKey &&
      connected &&
      !loading &&
      !pending &&
      !cancelling &&
      !reconnecting &&
      !needsReconcile,
  );
  function chooseSession(next: HarnessClientSession) {
    drafts.current.set(`${workspaceKey}:${session?.sessionId ?? ""}`, prompt);
    setPrompt(drafts.current.get(`${workspaceKey}:${next.sessionId}`) ?? "");
    setSession(next);
  }
  async function perform(
    label: string,
    job: () => Promise<void>,
    mutation = false,
  ) {
    // React state is not a lock: two activations can arrive before the next render.
    if (inFlight.current || cancelInFlight.current || reconnectInFlight.current) return;
    inFlight.current = true;
    mutationEpoch.current++;
    setError("");
    setPending(label);
    setRefresh((n) => n + 1);
    try {
      await job();
    } catch (e) {
      setError(errorText(e));
      if (errorText(e) === "WEB_REQUEST_FAILED") setConnected(false);
      if (mutation) setNeedsReconcile(true);
    } finally {
      mutationEpoch.current++;
      inFlight.current = false;
      setPending("");
      setRefresh((n) => n + 1);
    }
  }
  async function restoreConnection() {
    if (reconnectInFlight.current || cancelInFlight.current) return;
    reconnectInFlight.current = true;
    setReconnecting(true);
    setError("");
    const epoch = ++mutationEpoch.current;
    setRefresh((n) => n + 1);
    try {
      const c = await reconnect();
      const target = workspaceKey || c.workspaces[0]?.key;
      if (!target) throw new Error("WEB_WORKSPACE_REQUIRED");
      const list = await action<Sessions>(target, "sessions");
      const current =
        list.data.sessions.find((s) => s.sessionId === sessionId) ??
        list.data.sessions[0];
      let detail: HarnessClientRun | undefined;
      let unavailable = false;
      if (current?.runs.length) {
        try {
          detail = (
            await action<Run>(target, "run", {
              sessionId: current.sessionId,
              runId: current.runs.at(-1)!.runId,
            })
          ).data.run;
        } catch (e) {
          if (errorText(e) !== "NOT_FOUND") throw e;
          unavailable = true;
        }
      }
      // A command may finish during the read. Keep its newer receipt and let
      // polling reconcile instead of replacing it with an older snapshot.
      if (epoch !== mutationEpoch.current) return;
      setContext(c);
      setWorkspaceKey(target);
      setSessions(list.data.sessions);
      setSession(current);
      setRun(detail);
      setRunUnavailable(unavailable);
      setReview(undefined);
      setSessionsLoading(false);
      setStateLoading(false);
      setConnected(true);
      setNeedsReconcile(false);
      setError(unavailable ? "RUN_STATE_UNAVAILABLE" : "");
    } catch (e) {
      setConnected(false);
      setError(errorText(e));
    } finally {
      mutationEpoch.current++;
      reconnectInFlight.current = false;
      setReconnecting(false);
      setRefresh((n) => n + 1);
    }
  }
  async function create() {
    if (!canMutate) return;
    await perform(
      "Creating session…",
      async () => {
        const result = await action<Session>(workspaceKey, "create", {
          idempotencyKey: key(),
          title: "New session",
        });
        setSessions((previous) => [result.data.session, ...previous]);
        chooseSession(result.data.session);
        focusPrompt.current = true;
      },
      true,
    );
  }
  async function start() {
    if (!session || !prompt.trim() || !canMutate || busy) return;
    const input = prompt;
    await perform(
      "Starting task…",
      async () => {
        let current = session;
        if (!current.runs.length && current.title === "New session") {
          current = (
            await action<Session>(workspaceKey, "rename", {
              sessionId: current.sessionId,
              expectedRevision: current.revision,
              idempotencyKey: key(),
              title: input.trim().slice(0, 96),
            })
          ).data.session;
        }
        const result = await action<Run>(workspaceKey, "start", {
          sessionId: session.sessionId,
          expectedRevision: current.revision,
          idempotencyKey: key(),
          prompt: input,
        });
        setSession(result.data.session);
        setRun(result.data.run);
        setPrompt((currentDraft) =>
          currentDraft === input ? "" : currentDraft,
        );
      },
      true,
    );
  }
  async function loadReview() {
    if (!session || !run || !canMutate || run.status !== "waiting_approval")
      return;
    const selected = selection.current;
    await perform("Loading exact review…", async () => {
      // Start the local cutoff before the host issues its five-minute ticket.
      const deadline = Date.now() + 5 * 60_000;
      const r = await action<TicketedApprovalReview>(workspaceKey, "review", {
        sessionId: session.sessionId,
        runId: run.runId,
      });
      if (
        selection.current.workspaceKey === selected.workspaceKey &&
        selection.current.sessionId === selected.sessionId
      ) {
        setNow(Date.now());
        setReviewDeadline(deadline);
        setReview(r);
      }
    });
  }
  const reviewInvalid = review
    ? !run ||
      review.runId !== run.runId ||
      review.revision !== run.revision ||
      run.status !== "waiting_approval"
      ? "The run changed. Load a fresh review before deciding."
      : now >= reviewDeadline || review.items.some((i) => i.expiresAt <= now)
        ? "This review expired. Load a fresh review before deciding."
        : !connected || needsReconcile
          ? "Reconnect to read the current state before deciding."
          : ""
    : "";
  async function decide(approve: boolean) {
    if (
      !review ||
      !canMutate ||
      reviewInvalid ||
      Date.now() >= reviewDeadline ||
      review.items.some((i) => i.expiresAt <= Date.now()) ||
      (approve && !review.canApprove)
    )
      return;
    const ticket = review.ticketId;
    setReview(undefined);
    await perform(
      approve ? "Submitting approval…" : "Submitting denial…",
      async () => {
        const result = await action<Run>(workspaceKey, "decide", {
          ticketId: ticket,
          approve,
        });
        setSession(result.data.session);
        setRun(result.data.run);
      },
      true,
    );
  }
  const canCancel = Boolean(
    session &&
      run &&
      connected &&
      !loading &&
      !needsReconcile &&
      !cancelling &&
      !reconnecting &&
      run.status !== "cancel_requested" &&
      (active(run.status) || run.status === "waiting_approval") &&
      (!pending ||
        [
          "Starting task…",
          "Submitting approval…",
          "Submitting denial…",
        ].includes(pending)),
  );
  async function cancel() {
    // The host keeps start/decision responses open while working. Cancellation
    // must use its independent active-run control path during those requests.
    if (!session || !run || !canCancel || cancelInFlight.current || reconnectInFlight.current) return;
    cancelInFlight.current = true;
    setCancelling(true);
    setReview(undefined);
    setError("");
    mutationEpoch.current++;
    setRefresh((n) => n + 1);
    try {
      const result = await action<Run>(workspaceKey, "cancel", {
        sessionId: session.sessionId,
        runId: run.runId,
        expectedRevision: run.revision,
        idempotencyKey: key(),
      });
      setSession(result.data.session);
      setRun(result.data.run);
    } catch (e) {
      setError(errorText(e));
      setNeedsReconcile(true);
      if (errorText(e) === "WEB_REQUEST_FAILED") setConnected(false);
    } finally {
      mutationEpoch.current++;
      cancelInFlight.current = false;
      setCancelling(false);
      setRefresh((n) => n + 1);
    }
  }
  const workspace = ctx?.workspaces.find((w) => w.key === workspaceKey);
  const currentModel = JSON.stringify([workspace?.provider, workspace?.model]);
  useEffect(() => {
    if (!workspaceKey || !connected) return;
    let stopped = false;
    setModelChoices([]); setModelError(""); setModelChoice(currentModel); setModelsLoading(true);
    void action<{choices: WebModelChoice[]}>(workspaceKey, "models")
      .then(result => { if (!stopped) setModelChoices(result.choices); })
      .catch(error => { if (!stopped) setModelError(errorText(error)); })
      .finally(() => { if (!stopped) setModelsLoading(false); });
    return () => { stopped = true; };
  }, [workspaceKey, connected, currentModel, ctx]);
  async function selectModel() {
    if (!canMutate || busy || review || !modelChoice || modelChoice === currentModel) return;
    const [provider, model] = JSON.parse(modelChoice) as string[];
    await perform("Applying model for future tasks…", async () => {
      await action(workspaceKey, "selectModel", {provider, model});
      setReview(undefined);
      const c = await reconnect(); setContext(c);
      setRefresh(n => n + 1);
    }, true);
  }
  const stateLabel = loading
    ? "Loading state…"
    : !connected
      ? "Connection unavailable"
      : needsReconcile
        ? "Reconciliation required"
        : runUnavailable
          ? "State unavailable"
          : run
            ? human(run.status)
            : "Ready";
  const composerHelp = needsReconcile
    ? "The response was not confirmed. Reconnect before another action; nothing is retried automatically."
    : !connected
      ? "Connection lost. Admitted work may still be running on the host."
      : loading
        ? "Reading the current session before enabling actions…"
        : runUnavailable
          ? recovery.RUN_STATE_UNAVAILABLE
          : run?.status === "waiting_approval"
            ? "Review the proposed operation or cancel this run. Your next draft stays here."
            : run?.status === "cancel_requested"
              ? "Cancellation requested. Waiting for the host to confirm the final state."
              : busy
                ? "Work is running. You can prepare the next draft or cancel this run."
                : session
                  ? "Your task runs in this workspace after you submit it."
                  : "Create a session to begin.";
  const tools = Object.values(activity.runs).flatMap((r) =>
    Object.values(r.tools ?? {}).map((tool) => ({
      ...tool,
      status:
        tool.status === "running"
          ? r.status === "waiting_approval"
            ? "awaiting approval"
            : active(r.status)
              ? "running"
              : "no completion receipt"
          : tool.status,
    })),
  );
  const checks = tools.filter((t) => t.name === "run_check");
  const selected = sessions.filter((s) =>
    (s.title ?? s.sessionId).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#task-workspace">
        Skip to task workspace
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a href="/" className="brand" aria-label="Zhivex Code home">
          <img className="brand-mark" src="/zhivex-icon.png" alt="" width={36} height={36} />
          <span>
            zhivex<span className="brand-code">code</span>
          </span>
          <span className="local-tag">LOCAL</span>
        </a>
        <div className="workspace-picker">
          <label htmlFor="workspace">WORKSPACE</label>
          <select
            id="workspace"
            value={workspaceKey}
            disabled={
              Boolean(pending) || cancelling || reconnecting || needsReconcile
            }
            onChange={(e) => {
              drafts.current.set(`${workspaceKey}:${sessionId ?? ""}`, prompt);
              setPrompt("");
              setSearch("");
              setWorkspaceKey(e.target.value);
            }}
          >
            {ctx?.workspaces.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
          </select>
          <p title={workspace?.workspace}>
            {workspace?.workspace ?? "Connecting to local engine…"}
          </p>
        </div>
        <div className="sessions-heading">
          <span>SESSIONS</span>
          <button
            className="icon-button"
            aria-label="New session"
            disabled={!canMutate}
            onClick={() => void create()}
          >
            ＋
          </button>
        </div>
        <input
          className="session-search"
          aria-label="Search sessions"
          placeholder="Find a session…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <nav
          className="session-list"
          aria-label="Sessions"
          aria-busy={sessionsLoading}
        >
          {sessionsLoading ? (
            <p className="session-empty" role="status">
              Loading sessions…
            </p>
          ) : (
            !selected.length && (
              <p className="session-empty">
                {search
                  ? "No sessions match your search."
                  : connected
                    ? "No sessions yet. Create one to start."
                    : "Reconnect to load sessions."}
              </p>
            )
          )}
          {selected.map((s) => (
            <button
              key={s.sessionId}
              className={
                sessionId === s.sessionId
                  ? "session-row selected"
                  : "session-row"
              }
              aria-current={sessionId === s.sessionId ? "page" : undefined}
              disabled={
                Boolean(pending) || cancelling || reconnecting || needsReconcile
              }
              onClick={() => chooseSession(s)}
            >
              <span className="session-icon">◈</span>
              <span>
                <strong>{s.title ?? "Untitled session"}</strong>
                <small>
                  {s.runs.length} turn{s.runs.length === 1 ? "" : "s"} ·{" "}
                  {new Date(s.updatedAt).toLocaleDateString()}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={connected ? "status-dot" : "status-dot offline"} />
          <span>
            {loading
              ? "Reading local state…"
              : connected
                ? "Local engine connected"
                : "Connection unavailable"}
          </span>
          <small>Harness protocol v1</small>
        </div>
      </aside>
      <main id="task-workspace" tabIndex={-1}>
        <header className="topbar">
          <div>
            <span className="breadcrumb">
              {workspace?.name ?? "Workspace"} <span>/</span>
            </span>
            <h1>{session?.title ?? "Developer workspace"}</h1>
          </div>
          <button
            className="subtle"
            disabled={reconnecting || cancelling}
            onClick={() => void restoreConnection()}
          >
            ↻ Reconnect
          </button>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            <strong>{human(error)}</strong>
            <span>
              {recovery[error] ??
                "Read the current session state before submitting another action."}
            </span>
            <button
              className="subtle"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {(pending || cancelling || reconnecting) && (
          <div className="operation-status" role="status">
            {reconnecting
              ? "Reading durable state…"
              : cancelling
                ? "Requesting cancellation…"
                : pending === "Starting task…" && run && active(run.status)
                  ? "Task admitted. Following host activity…"
                  : pending}
          </div>
        )}
        <div className={`content-grid ${review ? "with-review" : ""}`}>
          <ChatRoot className="conversation" label="Task stream" theme="dark">
            <div className="section-heading">
              <span>Task stream</span>
              <span
                className={`pill ${run?.status === "waiting_approval" ? "attention" : run?.status === "failed" || !connected || needsReconcile || runUnavailable ? "warning" : ""}`}
              >
                {stateLabel}
              </span>
            </div>
            <p className="state-guidance" id="composer-help">
              {composerHelp}
            </p>
            {run?.status === "waiting_approval" && (
              <a className="review-jump subtle" href="#review-panel">
                Go to pending review ↓
              </a>
            )}
            <div
              className="messages"
              role="log"
              aria-label="Run activity"
              aria-live="off"
            >
              {!activity.order.length && loading && (
                <p className="loading-state" role="status">
                  Loading durable activity…
                </p>
              )}
              {!activity.order.length &&
                !loading &&
                connected &&
                !session?.runs.length && (
                  <div className="empty-state">
                    <img className="workspace-glyph" src="/zhivex-icon.png" alt="" width={56} height={56} />
                    <p className="eyebrow">YOUR CODE. YOUR WORKSPACE.</p>
                    <h2>What are we building?</h2>
                    <p>
                      Start a task, follow the work, and review
                      <br />
                      each operation that needs your approval.
                    </p>
                    <div className="starter-list">
                      {[
                        "Inspect this project and suggest a focused improvement",
                        "Explain the architecture and existing checks",
                        "Review the current changes for potential issues",
                      ].map((text) => (
                        <button
                          key={text}
                          disabled={!session || Boolean(pending)}
                          onClick={() => {
                            setPrompt(text);
                            promptInput.current?.focus();
                          }}
                        >
                          {text}
                          <span>↗</span>
                        </button>
                      ))}
                    </div>
                    {!session && (
                      <button
                        className="primary"
                        disabled={!canMutate}
                        onClick={() => void create()}
                      >
                        Create a session
                      </button>
                    )}
                  </div>
                )}
              {activity.order.map((id) => {
                const retained = activity.runs[id]!;
                const r =
                  runUnavailable && session?.runs.at(-1)?.runId === id
                    ? { ...retained, status: "state unavailable" }
                    : retained;
                return (
                  <div className="turn" key={id}>
                    {r.prompt && (
                      <Message
                        showActions={false}
                        showStatus={false}
                        message={{
                          id: `user-${id}`,
                          role: "user",
                          parts: [{ type: "text", text: r.prompt }],
                          createdAt: 0,
                          status: "complete",
                        }}
                      />
                    )}
                    <article className="assistant-response" aria-label="Assistant response" aria-busy={active(r.status)}>
                      <MessageMarkdown text={r.text || (r.status === "waiting_approval"
                        ? "The proposed operation is ready for your review."
                        : active(r.status) ? "Working in your local workspace…" : "No text output recorded.")} />
                    </article>
                    {r.truncated && (
                      <p className="muted">Retained output is truncated.</p>
                    )}
                    <div className="turn-footer">
                      <code>{id.slice(0, 18)}</code>
                      <span>{human(r.status)}</span>
                    </div>
                  </div>
                );
              })}
              {activity.recovered && (
                <p className="recovery-note">
                  Reconstructed from the durable activity snapshot.
                </p>
              )}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <label className="sr-only" htmlFor="prompt">
                Task prompt
              </label>
              <textarea
                id="prompt"
                ref={promptInput}
                aria-describedby="composer-help"
                placeholder={
                  session
                    ? "Describe a task for this workspace…"
                    : "Create a session to begin…"
                }
                value={prompt}
                maxLength={65536}
                disabled={!session || cancelling || (Boolean(pending) && !busy)}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void start();
                  }
                }}
              />
              <div className="composer-actions">
                <div className="model-picker">
                  <label className="sr-only" htmlFor="model-choice">Provider and model</label>
                  <select id="model-choice" value={modelChoice || currentModel}
                    disabled={!canMutate || busy || run?.status === "waiting_approval" || !modelChoices.length}
                    aria-describedby="model-help" onChange={e => setModelChoice(e.target.value)}>
                    {!modelChoices.some(c => JSON.stringify([c.provider,c.model]) === currentModel) &&
                      <option value={currentModel}>{workspace?.provider} / {workspace?.model} (current host model)</option>}
                    {[...new Set(modelChoices.map(c => c.provider))].map(provider => {
                      const items = modelChoices.filter(c => c.provider === provider);
                      return <optgroup key={provider} label={items[0]!.providerName}>
                        {items.map(c => <option key={c.model} value={JSON.stringify([c.provider,c.model])} disabled={!c.configured}>
                          {c.name}{!c.configured ? " · credential unavailable" : c.validation === "unverified" ? " · unverified" : ""}
                        </option>)}
                      </optgroup>;
                    })}
                  </select>
                  {modelChoice && modelChoice !== currentModel && <button type="button"
                    disabled={!canMutate || busy || run?.status === "waiting_approval"}
                    onClick={() => void selectModel()}>Apply model</button>}
                </div>
                <button
                  className="primary"
                  disabled={!session || !prompt.trim() || !canMutate || busy}
                  type="submit"
                >
                  Run task <span>↑</span>
                </button>
              </div>
            </form>
            <div className="composer-note">
              <span>⌘ / Ctrl + Enter to run</span>
              <span>Credentials stay on the host</span>
            </div>
            <p id="model-help" className="model-help">
              {modelsLoading ? "Reading configured providers and model choices…" : modelError ? "Model choices unavailable. Reconnect to refresh." : !modelChoices.length
                ? "Using the host model. No selectable catalog is available."
                : "Applies to future tasks in this workspace. Credential presence does not verify model access."}
            </p>
          </ChatRoot>
          <aside className="inspector" aria-label="Review and activity">
            <section
              className="review-panel"
              id="review-panel"
              tabIndex={-1}
              aria-label="Pending review"
            >
              <div className="section-heading">
                <span>Review</span>
                <span className="count">{run?.approvals.length ?? 0}</span>
              </div>
              {run?.status === "waiting_approval" ? (
                <>
                  <div className="approval-notice">
                    <span>◈</span>
                    <div>
                      <strong>Your approval is required</strong>
                      <p>
                        Inspect the exact operation and its content
                        preconditions before continuing.
                      </p>
                    </div>
                  </div>
                  <button
                    className="primary wide"
                    disabled={!canMutate}
                    onClick={() => void loadReview()}
                  >
                    {review
                      ? "Refresh exact review"
                      : "Review proposed operation"}
                  </button>
                </>
              ) : (
                <div className="quiet-state">
                  <span aria-hidden="true">
                    {loading || !connected || needsReconcile || runUnavailable ? "…" : "✓"}
                  </span>
                  <p>
                    {loading
                      ? "Loading approval state…"
                      : !connected || needsReconcile || runUnavailable
                        ? "Approval state unavailable."
                        : "No operations awaiting approval."}
                  </p>
                  <small>Requests will appear here before execution.</small>
                </div>
              )}
              {review && (
                <div className="review-content" aria-label="Approval review">
                  <h3 ref={reviewHeading} tabIndex={-1}>
                    Exact pending operation
                  </h3>
                  <p className="review-scope">
                    {review.items.length} operation
                    {review.items.length === 1 ? "" : "s"} ·{" "}
                    {review.items.reduce((n, item) => n + item.files.length, 0)}{" "}
                    file
                    {review.items.reduce(
                      (n, item) => n + item.files.length,
                      0,
                    ) === 1
                      ? ""
                      : "s"}
                  </p>
                  {reviewInvalid && (
                    <p className="restriction" role="status">
                      {reviewInvalid}
                    </p>
                  )}
                  <p className="muted">
                    Run revision {review.revision} · exact pending set
                  </p>
                  {review.items.map((item) => (
                    <article key={item.approvalId}>
                      <h4 className="review-operation">{human(item.name)}</h4>
                      <p>{item.consequence}</p>
                      {item.files.map((file, index) => (
                        <div className="review-file" key={index}>
                          <h4>{file.path}</h4>
                          <FileDiff before={file.before} after={file.after} />
                        </div>
                      ))}
                      {item.commands.map((command, index) => (
                        <pre key={index}>{command}</pre>
                      ))}
                      <details>
                        <summary>Exact payload and preconditions</summary>
                        <pre>{item.payload}</pre>
                        <code>{item.payloadDigest}</code>
                      </details>
                      {!item.complete && (
                        <p role="status" className="restriction">
                          Approval unavailable: {item.restriction}
                        </p>
                      )}
                    </article>
                  ))}
                  <div className="decision-actions">
                    <button
                      className="subtle"
                      disabled={!canMutate || Boolean(reviewInvalid)}
                      onClick={() => void decide(false)}
                    >
                      Deny operation
                    </button>
                    <button
                      className="primary"
                      disabled={
                        !canMutate ||
                        !review.canApprove ||
                        Boolean(reviewInvalid)
                      }
                      onClick={() => void decide(true)}
                    >
                      Approve & continue
                    </button>
                  </div>
                </div>
              )}
            </section>
            <section className="activity-panel">
              <div className="section-heading">
                <span>Activity & checks</span>
                <span className="count">{tools.length}</span>
              </div>
              {!tools.length ? (
                <div className="quiet-state small">
                  <p>Tool activity appears as work progresses.</p>
                </div>
              ) : (
                <ul className="tool-list">
                  {tools.map((tool, i) => (
                    <li key={i}>
                      <span
                        className={
                          tool.status === "failed"
                            ? "tool-icon failed"
                            : "tool-icon"
                        }
                      >
                        {tool.status === "failed"
                          ? "!"
                          : tool.status === "running"
                            ? "◌"
                            : tool.status === "completed"
                              ? "✓"
                              : "◇"}
                      </span>
                      <div>
                        <strong>{human(tool.name)}</strong>
                        <small>
                          {tool.exitCode === undefined
                            ? human(tool.status)
                            : `exit ${tool.exitCode}${tool.timedOut ? " · timed out" : ""}`}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {checks.length > 0 && (
                <p className="check-summary">
                  {checks.filter((c) => c.exitCode === 0 && !c.timedOut).length}
                  /{checks.length} checks passed
                </p>
              )}
            </section>
            {run && (
              <section className="run-panel">
                <div className="section-heading">
                  <span>Current run</span>
                </div>
                <dl>
                  <dt>Status</dt>
                  <dd>{human(run.status)}</dd>
                  <dt>Revision</dt>
                  <dd>{run.revision}</dd>
                </dl>
                {(active(run.status) || run.status === "waiting_approval") && (
                  <button
                    className="danger wide"
                    disabled={!canCancel}
                    onClick={() => void cancel()}
                  >
                    {run.status === "cancel_requested"
                      ? "Cancellation requested"
                      : cancelling
                        ? "Requesting cancellation…"
                        : "Cancel run"}
                  </button>
                )}
                {run.decisions
                  ?.filter((d) => d.finalDiff?.status === "complete")
                  .map((d) => (
                    <details key={d.approvalId}>
                      <summary>
                        Applied change ·{" "}
                        {d.finalDiff?.status === "complete"
                          ? d.finalDiff.files.length
                          : 0}{" "}
                        files
                      </summary>
                      {d.finalDiff?.status === "complete" &&
                        d.finalDiff.files.map((f, i) => (
                          <div className="review-file" key={i}>
                            <h4>{f.path}</h4>
                            <FileDiff
                              before={f.before ?? undefined}
                              after={f.after ?? undefined}
                            />
                          </div>
                        ))}
                    </details>
                  ))}
              </section>
            )}
            <p className="local-note">
              This browser is paired with a local process. Workspace access and
              execution remain governed by Harness.
            </p>
          </aside>
        </div>
      </main>
      <div className="sr-only" role="status" aria-live="polite">
        {stateLabel}
      </div>
    </div>
  );
}
