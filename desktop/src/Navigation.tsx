import {CredentialSettings} from "./CredentialSettings.js";
import {UpdateSettings} from "./UpdateSettings.js";
import type { KeyboardEvent } from "react";
import type { DesktopContext, DesktopProject, DesktopProvider } from "./bridge.js";
import type { HarnessClientSession } from "../../src/client-contract.js";
const arrows = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement); if (current < 0 || !buttons.length) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus();
};
export function Navigation(props: { credentialsChanged:()=>Promise<void>; providers: DesktopProvider[]; projects: DesktopProject[]; context: DesktopContext | undefined; sessions: HarnessClientSession[]; selectedSession: string | undefined; loading: boolean; open: () => void; selectProject: (key: string) => void; selectSession: (id: string) => void; create: () => void }) {
    return <aside><div className="brand">◈ ZHIVEX <span>HARNESS</span></div><button className="open-project secondary" data-action="open-project" onClick={props.open} disabled={props.loading}>＋ Abrir repositorio</button>
        <nav aria-label="Proyectos recientes" onKeyDown={arrows}><h2 className="nav-heading">PROYECTOS RECIENTES</h2>{props.projects.length ? props.projects.map(project => <button key={project.key} data-project={project.key} className="nav-item" aria-current={props.context?.project.key === project.key ? "page" : undefined} disabled={props.loading} title={project.workspace} onClick={() => props.selectProject(project.key)}>{project.name}</button>) : <p className="muted">Todavía no hay proyectos.</p>}</nav>
        <nav aria-label="Conversaciones" onKeyDown={arrows}><div className="nav-heading-row"><h2 className="nav-heading">CONVERSACIONES</h2><button className="icon-button" data-action="new-session" aria-label="Nueva conversación" disabled={!props.context || props.loading} onClick={props.create}>＋</button></div>{props.sessions.map((session, index) => <button key={session.sessionId} data-session={session.sessionId} className="nav-item" aria-current={props.selectedSession === session.sessionId ? "page" : undefined} disabled={props.loading} onClick={() => props.selectSession(session.sessionId)}>{session.title ?? `Conversación ${index + 1}`}<small>{session.runs.at(-1)?.status ?? "Sin mensajes"}</small></button>)}{props.context && !props.sessions.length ? <p className="muted">Creá tu primera conversación.</p> : null}</nav>
        <div className="connection">● {props.context ? "Servicio local conectado" : "Elegí un repositorio"}</div><CredentialSettings key={props.context?.modelSelection?.provider ?? "openai"} initialProvider={props.context?.modelSelection?.provider ?? "openai"} providers={props.providers} changed={props.credentialsChanged}/><UpdateSettings/></aside>;
}
