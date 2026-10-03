import { useEffect, useRef, useState } from "react";
import { ChatRoot, Message } from "@zhivex-ai/react/components";
import { FileDiff } from "../../../desktop/src/FileDiff.js";
import {
  applyActivityPage,
  emptyActivity,
  type ConversationActivity,
} from "../../../desktop/src/activity.js";
import { action, context, reconnect } from "./api.js";
import type {
  WebContext,
  HarnessClientRun,
  HarnessClientSession,
  HarnessActivityPage,
  TicketedApprovalReview,
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
  WEB_PAIRING_REQUIRED:
    "Restart zhivex-code web to open a freshly paired browser.",
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
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selection = useRef({ workspaceKey: "", sessionId: "" });
  selection.current = { workspaceKey, sessionId: session?.sessionId ?? "" };
  useEffect(() => {
    void context()
      .then((c) => {
        setContext(c);
        setWorkspaceKey(c.workspaces[0]?.key ?? "");
        setConnected(true);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!workspaceKey) return;
    let stopped = false;
    setSession(undefined);
    setRun(undefined);
    setRunUnavailable(false);
    setReview(undefined);
    setActivity(emptyActivity());
    void action<Sessions>(workspaceKey, "sessions")
      .then((r) => {
        if (stopped) return;
        setSessions(r.data.sessions);
        const saved = localStorage.getItem(`zhivex-session:${workspaceKey}`);
        setSession(
          r.data.sessions.find((s) => s.sessionId === saved) ??
            r.data.sessions[0],
        );
      })
      .catch((e) => {
        if (!stopped) setError(errorText(e));
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
    if (!workspaceKey || !sessionId) return;
    localStorage.setItem(`zhivex-session:${workspaceKey}`, sessionId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const page = await action<HarnessActivityPage>(workspaceKey, "events", {
          sessionId,
          after: activityRef.current.cursor,
        });
        if (stopped) return;
        const next = applyActivityPage(activityRef.current, page);
        activityRef.current = next;
        setActivity(next);
        const result = await action<Session>(workspaceKey, "session", {
          sessionId,
        });
        if (stopped) return;
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
          try {
            const detail = await action<Run>(workspaceKey, "run", {
              sessionId,
              runId: latest.runId,
            });
            if (stopped) return;
            setRun(detail.data.run);
            setRunUnavailable(false);
          } catch (e) {
            if (stopped) return;
            if (errorText(e) !== "NOT_FOUND") throw e;
            setRun(undefined);
            setRunUnavailable(true);
            setReview(undefined);
            setError("RUN_STATE_UNAVAILABLE");
          }
        }
        setConnected(true);
        timer = setTimeout(() => void poll(), page.hasMore ? 20 : 650);
      } catch (e) {
        if (stopped) return;
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
  async function perform(job: () => Promise<void>) {
    setError("");
    setPending(true);
    try {
      await job();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  async function create() {
    await perform(async () => {
      const result = await action<Session>(workspaceKey, "create", {
        idempotencyKey: key(),
        title: "New session",
      });
      setSessions((previous) => [result.data.session, ...previous]);
      setSession(result.data.session);
    });
  }
  async function start() {
    if (!session || !prompt.trim()) return;
    const selected = selection.current;
    const input = prompt;
    setPrompt("");
    await perform(async () => {
      let current = session;
      if (!current.runs.length && current.title === "New session") {
        const renamed = await action<Session>(workspaceKey, "rename", {
          sessionId: current.sessionId,
          expectedRevision: current.revision,
          idempotencyKey: key(),
          title: input.trim().slice(0, 96),
        });
        current = renamed.data.session;
      }
      const result = await action<Run>(workspaceKey, "start", {
        sessionId: session.sessionId,
        expectedRevision: current.revision,
        idempotencyKey: key(),
        prompt: input,
      });
      if (
        selection.current.workspaceKey === selected.workspaceKey &&
        selection.current.sessionId === selected.sessionId
      ) {
        setSession(result.data.session);
        setRun(result.data.run);
      }
    });
  }
  async function loadReview() {
    if (!session || !run) return;
    const selected = selection.current;
    await perform(async () => {
      const r = await action<TicketedApprovalReview>(workspaceKey, "review", {
        sessionId: session.sessionId,
        runId: run.runId,
      });
      if (
        selection.current.workspaceKey === selected.workspaceKey &&
        selection.current.sessionId === selected.sessionId
      )
        setReview(r);
    });
  }
  async function decide(approve: boolean) {
    if (!review) return;
    const ticket = review.ticketId;
    setReview(undefined);
    await perform(async () => {
      await action<Run>(workspaceKey, "decide", { ticketId: ticket, approve });
      setRefresh((n) => n + 1);
    });
  }
  async function cancel() {
    if (!session || !run) return;
    setReview(undefined);
    await perform(async () => {
      await action<Run>(workspaceKey, "cancel", {
        sessionId: session.sessionId,
        runId: run.runId,
        expectedRevision: run.revision,
        idempotencyKey: key(),
      });
      setRefresh((n) => n + 1);
    });
  }
  const workspace = ctx?.workspaces.find((w) => w.key === workspaceKey);
  const busy =
    runUnavailable ||
    (run ? active(run.status) || run.status === "waiting_approval" : false);
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
      <aside className="sidebar" aria-label="Workspace navigation">
        <a href="/" className="brand" aria-label="Zhivex Code home">
          <span className="brand-mark">Z</span>
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
            onChange={(e) => setWorkspaceKey(e.target.value)}
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
            disabled={!ctx || pending}
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
        <nav className="session-list" aria-label="Sessions">
          {selected.map((s) => (
            <button
              key={s.sessionId}
              className={
                sessionId === s.sessionId
                  ? "session-row selected"
                  : "session-row"
              }
              onClick={() => setSession(s)}
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
            {connected ? "Local engine connected" : "Connection unavailable"}
          </span>
          <small>Harness protocol v1</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">
              {workspace?.name ?? "Workspace"} <span>/</span>
            </span>
            <h1>{session?.title ?? "Developer workspace"}</h1>
          </div>
          <button
            className="subtle"
            onClick={() =>
              void perform(async () => {
                await reconnect();
                setRefresh((n) => n + 1);
                setError("");
              })
            }
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
        <div className="content-grid">
          <ChatRoot className="conversation" label="Task stream" theme="dark">
            <div className="section-heading">
              <span>Task stream</span>
              <span className="pill">
                {run
                  ? human(run.status)
                  : runUnavailable
                    ? "State unavailable"
                    : "Ready"}
              </span>
            </div>
            <div
              className="messages"
              role="log"
              aria-label="Run activity"
              aria-live="off"
            >
              {!activity.order.length && (
                <div className="empty-state">
                  <div className="workspace-glyph">⌘</div>
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
                      <button key={text} onClick={() => setPrompt(text)}>
                        {text}
                        <span>↗</span>
                      </button>
                    ))}
                  </div>
                  {!session && (
                    <button
                      className="primary"
                      disabled={!ctx || pending}
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
                    <Message
                      showActions={false}
                      showStatus={false}
                      message={{
                        id,
                        role: "assistant",
                        parts: [
                          {
                            type: "text",
                            text:
                              r.text ||
                              (r.status === "waiting_approval"
                                ? "The proposed operation is ready for your review."
                                : active(r.status)
                                  ? "Working in your local workspace…"
                                  : "No text output recorded."),
                          },
                        ],
                        createdAt: 0,
                        status: active(r.status) ? "streaming" : "complete",
                      }}
                    />
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
                placeholder={
                  session
                    ? "Describe a task for this workspace…"
                    : "Create a session to begin…"
                }
                value={prompt}
                maxLength={65536}
                disabled={!session}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    if (!pending && !busy) void start();
                  }
                }}
              />
              <div className="composer-actions">
                <span>
                  {workspace?.provider}{" "}
                  <span className="muted">/ {workspace?.model}</span>
                </span>
                <button
                  className="primary"
                  disabled={
                    !session || !prompt.trim() || pending || busy || !connected
                  }
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
          </ChatRoot>
          <aside className="inspector" aria-label="Review and activity">
            <section className="review-panel">
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
                    disabled={pending}
                    onClick={() => void loadReview()}
                  >
                    Review proposed operation
                  </button>
                </>
              ) : (
                <div className="quiet-state">
                  <span>✓</span>
                  <p>No operations awaiting approval.</p>
                  <small>Requests will appear here before execution.</small>
                </div>
              )}
              {review && (
                <div className="review-content" aria-label="Approval review">
                  <p className="muted">
                    Run revision {review.revision} · exact pending set
                  </p>
                  {review.items.map((item) => (
                    <article key={item.approvalId}>
                      <h3>{human(item.name)}</h3>
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
                      disabled={pending}
                      onClick={() => void decide(false)}
                    >
                      Deny operation
                    </button>
                    <button
                      className="primary"
                      disabled={
                        pending ||
                        !review.canApprove ||
                        review.revision !== run?.revision ||
                        review.items.some((i) => i.expiresAt <= Date.now())
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
                    disabled={!connected}
                    onClick={() => void cancel()}
                  >
                    Cancel run
                  </button>
                )}
                {run.decisions
                  ?.filter((d) => d.finalDiff?.status === "complete")
                  .map((d) => (
                    <details key={d.approvalId}>
                      <summary>Applied change</summary>
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
        {run?.status === "waiting_approval"
          ? "Operation waiting for approval"
          : run
            ? `Run ${human(run.status)}`
            : "Ready"}
      </div>
    </div>
  );
}
