import { readPreference, writePreference } from "./local-preferences.js";
import { CredentialSettings } from "./CredentialSettings.js";
import { UpdateSettings } from "./UpdateSettings.js";
import { useState, type KeyboardEvent } from "react";
import { FolderOpen, MessageSquare, Plus, Search } from "lucide-react";
import type {
  DesktopContext,
  DesktopProject,
  DesktopProvider,
} from "./bridge.js";
import type { HarnessClientSession } from "../../src/internal/desktop/protocol.js";
const arrows = (event: KeyboardEvent<HTMLElement>) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ),
  ).filter((button) => button.getClientRects().length > 0);
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0 || !buttons.length) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next]?.focus();
};
export function Navigation(props: {
  hidden: boolean;
  connection: "connecting" | "connected" | "disconnected" | "closed";
  credentialDialog: boolean;
  setCredentialDialog: (open: boolean) => void;
  rename: (id: string, title: string) => Promise<void>;
  credentialsChanged: () => Promise<void>;
  providers: DesktopProvider[];
  projects: DesktopProject[];
  context: DesktopContext | undefined;
  sessions: HarnessClientSession[];
  selectedSession: string | undefined;
  loading: boolean;
  open: () => void;
  selectProject: (key: string) => void;
  selectSession: (id: string) => void;
  create: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [archiveVersion, setArchiveVersion] = useState(0);
  const [renaming, setRenaming] = useState<string>();
  const [title, setTitle] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const project = props.context?.project.key ?? "";
  const archived = (id: string) =>
    readPreference("archive", project, id) === "true";
  const [query, setQuery] = useState("");
  const sessions = props.sessions
    .map((session, index) => ({
      session,
      title: session.title ?? `Conversation ${index + 1}`,
    }))
    .filter(({ title }) =>
      title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .filter(({ session }) => {
      if (filter === "archived") return archived(session.sessionId);
      if (archived(session.sessionId)) return false;
      const status = session.runs.at(-1)?.status;
      return (
        filter === "all" ||
        (filter === "attention"
          ? status === "waiting_approval" || status === "failed"
          : ["created", "queued", "running", "cancel_requested"].includes(
              status ?? "",
            ))
      );
    });
  return (
    <aside id="sidebar" hidden={props.hidden}>
      <div className="brand">
        <span className="brand-mark">
          <img src="./zhivex-logo.png" alt="" width={36} height={36} />
        </span>
        <div>
          Zhivex <span>Harness</span>
        </div>
      </div>
      <button
        className="new-conversation"
        data-action="new-session"
        disabled={!props.context || props.loading}
        onClick={() => {
          setQuery("");
          setFilter("all");
          props.create();
        }}
      >
        <Plus size={16} aria-hidden="true" />
        New conversation
      </button>
      <button
        className="open-project secondary"
        data-action="open-project"
        onClick={props.open}
        disabled={props.loading}
      >
        <FolderOpen size={16} aria-hidden="true" />
        Open repository
      </button>
      <div className="sidebar-content">
        <nav aria-label="Recent projects" onKeyDown={arrows}>
          <h2 className="nav-heading">Recent projects</h2>
          {props.projects.length ? (
            props.projects.map((project) => (
              <button
                key={project.key}
                data-project={project.key}
                className="nav-item project-item"
                aria-current={
                  props.context?.project.key === project.key
                    ? "page"
                    : undefined
                }
                disabled={props.loading}
                title={project.workspace}
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  props.selectProject(project.key);
                }}
              >
                <FolderOpen size={15} aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))
          ) : (
            <p className="muted">Your repositories will appear here.</p>
          )}
        </nav>
        <label className="sidebar-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search conversations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
          />
        </label>
        <nav aria-label="Conversations" onKeyDown={arrows}>
          <div className="nav-heading-row">
            <h2 className="nav-heading">Conversations</h2>
            <span className="nav-count">{props.sessions.length}</span>
          </div>
          <select
            aria-label="Filter conversations"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">Conversations</option>
            <option value="active">Active</option>
            <option value="attention">Needs attention</option>
            <option value="archived">Archived</option>
          </select>
          {error ? <p role="alert">{error}</p> : null}
          {sessions.map(({ session, title: sessionTitle }) => (
            <div key={session.sessionId} className="session-row">
              <button
                key={session.sessionId}
                data-session={session.sessionId}
                className="nav-item session-item"
                aria-current={
                  props.selectedSession === session.sessionId
                    ? "page"
                    : undefined
                }
                disabled={props.loading}
                onClick={() => props.selectSession(session.sessionId)}
              >
                <MessageSquare size={15} aria-hidden="true" />
                <span>
                  {sessionTitle}
                  <small>{session.runs.at(-1)?.status ?? "No messages"}</small>
                </span>
              </button>
              <details className="session-actions">
                <summary aria-label={`Actions for ${sessionTitle}`}>
                  •••
                </summary>
                <button
                  type="button"
                  disabled={working || props.loading}
                  onClick={() => {
                    setRenaming(session.sessionId);
                    setTitle(sessionTitle);
                    setError("");
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={props.loading}
                  onClick={() => {
                    const saved = writePreference(
                      "archive",
                      project,
                      session.sessionId,
                      archived(session.sessionId) ? "" : "true",
                    );
                    setArchiveVersion(archiveVersion + 1);
                    if (!saved)
                      setError(
                        "Archive preference could not be saved to disk.",
                      );
                  }}
                >
                  {archived(session.sessionId) ? "Restore" : "Archive"}
                </button>
              </details>
              {renaming === session.sessionId ? (
                <form
                  className="rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!title.trim() || working) return;
                    setWorking(true);
                    setError("");
                    void props
                      .rename(session.sessionId, title.trim())
                      .then(
                        () => setRenaming(undefined),
                        () =>
                          setError(
                            "Could not rename the conversation. Refresh its status before trying again.",
                          ),
                      )
                      .finally(() => setWorking(false));
                  }}
                >
                  <input
                    aria-label="Conversation title"
                    value={title}
                    maxLength={256}
                    disabled={working}
                    onChange={(event) => setTitle(event.target.value)}
                    autoFocus
                  />
                  <button type="submit" disabled={working || !title.trim()}>
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setRenaming(undefined)}
                  >
                    Cancel
                  </button>
                </form>
              ) : null}
            </div>
          ))}
          {!sessions.length ? (
            <p className="muted">
              {query
                ? "No conversations found."
                : props.context
                  ? "An idea, a change, a new conversation."
                  : "Open a repository to get started."}
            </p>
          ) : null}
        </nav>
      </div>
      <div className="sidebar-footer">
        <div className="connection">
          <span
            className={
              props.connection === "connected"
                ? "connection-dot connected"
                : "connection-dot"
            }
          />
          {
            {
              connecting: "Connecting…",
              connected: "Local service connected",
              disconnected: "Connection interrupted · retrying",
              closed: "No repository open",
            }[props.connection]
          }
        </div>
        <CredentialSettings
          key={props.context?.modelSelection?.provider ?? "openai"}
          initialProvider={props.context?.modelSelection?.provider ?? "openai"}
          providers={props.providers}
          open={props.credentialDialog}
          onOpenChange={props.setCredentialDialog}
          changed={props.credentialsChanged}
        />
        <UpdateSettings />
      </div>
    </aside>
  );
}
