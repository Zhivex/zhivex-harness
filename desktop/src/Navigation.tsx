import { CredentialSettings } from "./CredentialSettings.js";
import { UpdateSettings } from "./UpdateSettings.js";
import { useState, type KeyboardEvent } from "react";
import {
  FolderOpen,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
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
  );
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
  const [query, setQuery] = useState("");
  const sessions = props.sessions
    .map((session, index) => ({
      session,
      title: session.title ?? `Conversation ${index + 1}`,
    }))
    .filter(({ title }) =>
      title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
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
          {sessions.map(({ session, title }) => (
            <button
              key={session.sessionId}
              data-session={session.sessionId}
              className="nav-item session-item"
              aria-current={
                props.selectedSession === session.sessionId ? "page" : undefined
              }
              disabled={props.loading}
              onClick={() => props.selectSession(session.sessionId)}
            >
              <MessageSquare size={15} aria-hidden="true" />
              <span>
                {title}
                <small>{session.runs.at(-1)?.status ?? "No messages"}</small>
              </span>
            </button>
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
              props.context ? "connection-dot connected" : "connection-dot"
            }
          />
          {props.context
            ? "Local service connected"
            : "No repository open"}
        </div>
        <CredentialSettings
          key={props.context?.modelSelection?.provider ?? "openai"}
          initialProvider={props.context?.modelSelection?.provider ?? "openai"}
          providers={props.providers}
          changed={props.credentialsChanged}
        />
        <UpdateSettings />
      </div>
    </aside>
  );
}
