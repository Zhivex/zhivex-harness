import { useEffect, useRef } from "react";
import type { HarnessClientSession } from "./contracts.js";
import type { WebWorkspace } from "./contracts.js";
import { ThemeSelector } from "./ThemeSelector.js";
import type { ThemeChoice } from "./theme.js";

export interface DrawerProject extends WebWorkspace {
  pending: number;
}

export function SessionsDrawer(props: {
  open: boolean;
  grouped: boolean;
  projects: DrawerProject[];
  currentKey: string;
  collapsed: ReadonlySet<string>;
  sessions: Record<string, HarnessClientSession[] | undefined>;
  loadingKey: string;
  sessionId?: string | undefined;
  search: string;
  statusFilter: boolean;
  statusFor: (projectKey: string, session: HarnessClientSession) => string;
  canSwitch: boolean;
  onSearch: (value: string) => void;
  onClose: () => void;
  onToggle: (key: string) => void;
  onOpenProject: (key: string) => void;
  onChoose: (key: string, session: HarnessClientSession) => void;
  onAdd: () => void;
  onForget: (key: string) => void;
  returnFocus: { current: HTMLElement | null };
  themeChoice: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.open) searchRef.current?.focus();
  }, [props.open]);
  const query = props.search.trim().toLowerCase();
  const projects = props.projects.filter(project => {
    if (!query) return true;
    const sessions = props.sessions[project.key] ?? [];
    return project.name.toLowerCase().includes(query) || project.workspace.toLowerCase().includes(query)
      || sessions.some(session => (session.title ?? "").toLowerCase().includes(query));
  });
  function items() {
    return [...treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-item]") ?? []];
  }
  return <div className={props.open ? "drawer-root open" : "drawer-root"} hidden={!props.open}>
    <button type="button" className="drawer-backdrop" aria-label="Close sessions" onClick={props.onClose} />
    <aside className="drawer" role="dialog" aria-label={props.grouped ? "Sessions by project" : "Sessions"}>
      <header>
        <h2>{props.grouped ? "Sessions" : "Sessions"}</h2>
        <button type="button" onClick={props.onClose}>Close</button>
      </header>
      <input ref={searchRef} aria-label="Search sessions" placeholder="Find a session or project" value={props.search}
        onChange={event => props.onSearch(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); props.returnFocus.current?.focus(); } }} />
      <div ref={treeRef} role="tree" aria-label="Sessions" className="session-tree"
        onKeyDown={event => {
          const node = items();
          const index = node.indexOf(document.activeElement as HTMLElement);
          if (event.key === "ArrowDown") { event.preventDefault(); node[Math.min(node.length - 1, index + 1)]?.focus(); }
          else if (event.key === "ArrowUp") { event.preventDefault(); node[Math.max(0, index - 1)]?.focus(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); props.returnFocus.current?.focus(); }
        }}>
        {props.loadingKey && !props.sessions[props.currentKey] ? <p className="session-empty" role="status">Loading sessions…</p> : null}
        {!projects.length && <p className="session-empty">{query ? "No sessions match your search." : "No sessions yet. Create one to start."}</p>}
        {projects.map(project => {
          const collapsed = props.grouped && props.collapsed.has(project.key);
          const sessions = (props.sessions[project.key] ?? []).filter(session => {
            if (query && !(session.title ?? "").toLowerCase().includes(query) && !project.name.toLowerCase().includes(query)) return false;
            if (!props.statusFilter) return true;
            return props.statusFor(project.key, session) === "Needs you";
          });
          return <div key={project.key} role="treeitem" aria-expanded={props.grouped ? !collapsed : undefined} className="project-group">
            {props.grouped && <div className="project-heading">
              <button type="button" data-tree-item disabled={!props.canSwitch} aria-current={project.key === props.currentKey ? "true" : undefined}
                onClick={() => props.onToggle(project.key)}
                onKeyDown={event => {
                  if (event.key === "ArrowRight" && collapsed) props.onToggle(project.key);
                  if (event.key === "ArrowLeft" && !collapsed) props.onToggle(project.key);
                }}>
                <span>{collapsed ? "▸" : "▾"}</span>
                <strong>{project.name}</strong>
                {project.key === props.currentKey ? <em>Current</em> : null}
                {project.pending > 0 ? <em className="needs-you-text">{project.pending} need you</em> : null}
              </button>
              <button type="button" data-tree-item disabled={!props.canSwitch || project.unavailable} onClick={() => props.onOpenProject(project.key)}>Open project {project.name}</button>
            </div>}
            {props.grouped && <p className="project-path">{project.workspace}</p>}
            {project.toolPolicy ? <p className="project-policy">Tool policy: {project.toolPolicy}</p> : null}
            {project.unavailable && <div className="project-unavailable" role="status">
              <strong>Unavailable</strong>
              <p>{project.cause}</p>
              <p>Register it again from the terminal with <code>zhivex-code project add</code>, or remove it from this list. Nothing is deleted from disk.</p>
              <button type="button" onClick={() => props.onForget(project.key)}>Remove from list</button>
            </div>}
            {!collapsed && !project.unavailable && <div role="group" className="session-list" aria-label={props.grouped ? `${project.name} sessions` : "Sessions"}>
              {props.sessions[project.key] === undefined ? <p className="session-empty" role="status">Loading sessions…</p> : null}
              {sessions.map(session => {
                const status = props.statusFor(project.key, session);
                return <button key={session.sessionId} type="button" data-tree-item className={props.sessionId === session.sessionId && project.key === props.currentKey ? "session-row selected" : "session-row"}
                  aria-current={props.sessionId === session.sessionId && project.key === props.currentKey ? "page" : undefined}
                  disabled={!props.canSwitch}
                  onClick={() => props.onChoose(project.key, session)}
                  onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); props.onChoose(project.key, session); } }}>
                  <strong>{session.title ?? "Untitled session"}</strong>
                  <small className={status === "Needs you" ? "needs-you-text" : undefined}>{status}</small>
                </button>;
              })}
              {!sessions.length && props.sessions[project.key] && <p className="session-empty">{query ? "No sessions match your search." : "No sessions yet. Create one to start."}</p>}
            </div>}
          </div>;
        })}
      </div>
      <footer>
        <ThemeSelector choice={props.themeChoice} onChange={props.onTheme} />
        {props.grouped ? <button type="button" onClick={props.onAdd}>Add project</button> : <button type="button" className="quiet-add" onClick={props.onAdd}>Add another project</button>}
      </footer>
    </aside>
  </div>;
}

export function AddProjectDialog(props: { open: boolean; onClose: () => void }) {
  if (!props.open) return null;
  return <div className="modal-root" role="presentation">
    <div className="modal" role="dialog" aria-labelledby="add-project-title">
      <h2 id="add-project-title">Add a project from the terminal</h2>
      <ol>
        <li>Open a terminal in the project folder.</li>
        <li>Run <code>zhivex-code project add</code>.</li>
        <li>Confirm the full path in the terminal.</li>
      </ol>
      <p>This page never asks for a folder and never opens one. The project shows up here after the terminal confirms it.</p>
      <button type="button" onClick={props.onClose}>Close</button>
    </div>
  </div>;
}
