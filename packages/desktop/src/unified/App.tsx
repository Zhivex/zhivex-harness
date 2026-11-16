import {conversationTitle, conversationStatus, findConversations} from "./conversation-resume.js";
import {RenameConversation} from './RenameConversation.js';
import {Proactive} from './Proactive.js';
import {MailDrafts} from './MailDrafts.js';
import {MessageEditor} from './MessageEditor.js';
import {EmptyState, Notice} from './ui.js';
import {CodeContext} from './CodeContext.js';
import {AssistantToday} from './AssistantToday.js';
import {CommandPalette, type PaletteItem} from './CommandPalette.js';
import type {NavigationPage} from './navigation.js';
import {useCompactNavigation} from './use-compact-navigation.js';
import {DecisionHistory} from './DecisionHistory.js';
import {useNavigation} from './use-navigation.js';
import {Notes} from './Notes.js';
import {Today} from './Today.js';
import {Automations} from './Automations.js';
import { Personal } from './Personal.js';
import { GitPanel } from "../GitPanel.js";
import { Worktrees } from './Worktrees.js';
import { Execution } from './Execution.js';
import { CheckpointPanel } from '../CheckpointPanel.js';
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, CalendarDays, CheckCheck, Code2, History, House, MessageSquare, Moon, PanelLeft, Plus, Search, ShieldCheck, Sun, Zap } from "lucide-react";
import type { HarnessClientRun, HarnessClientSession, HarnessClientResponse } from "@zhivex-ai/harness/protocol";
import type { UnifiedHost } from "./bridge.js";
import { emptyActivity, applyActivityPage } from "../activity.js";
import { readPreference, writePreference } from "../local-preferences.js";
import { Conversation } from "../Conversation.js";
import { CodeProjects } from "./Projects.js";
import { AssistantSetup } from "./Setup.js";
import { Review } from "./Review.js";

function data(result: HarnessClientResponse) { if (!result.ok) throw new Error(result.error.code); return result.data; }
const active = (run?: HarnessClientRun) => Boolean(run && ["created", "running", "queued", "cancel_requested"].includes(run.status));

export function UnifiedApp() {
  const [projects, setProjects] = useState(false);
  // Area is user navigation state, even before a workspace exists or a panel closes.
  const [area, setArea] = useState<"assistant" | "code">("assistant");
  const [connectionOrigin, setConnectionOrigin] = useState<"code" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const [settings, setSettings] = useState(false), [managed, setManaged] = useState(false);
  const [hosts, setHosts] = useState<UnifiedHost[]>([]), [hostId, setHostId] = useState("");
  const host = hosts.find(entry => entry.id === hostId && entry.area === area);
  const [sessions, setSessions] = useState<HarnessClientSession[]>([]), [sessionsReady, setSessionsReady] = useState(false);
  const {sessionId, setSessionId, page, setPage} = useNavigation(host?.projectId, area);
  const [session, setSession] = useState<HarnessClientSession>(), [run, setRun] = useState<HarnessClientRun>();
  const [activity, setActivity] = useState(emptyActivity), activityRef = useRef(emptyActivity());
  const [draft, setDraft] = useState(""), [draftStored, setDraftStored] = useState(true);

  const [pendingOnly, setPendingOnly] = useState(false);
  const [historyRunId, setHistoryRunId] = useState<string>();
  const [focusRunId, setFocusRunId] = useState<string>();
  const [filter, setFilter] = useState(""), [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [error, setError] = useState(""), [disconnected, setDisconnected] = useState(false), [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false), lock = useRef(false), uncertainHosts = useRef(new Set<string>());
  const firstSendTransition = useRef<{hostId: string; sessionId: string} | null>(null);
  const [cancelling, setCancelling] = useState(false), cancellationLock = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [theme, setTheme] = useState(() => readPreference("theme", "unified", "") || "light");
  const navigation = useCompactNavigation(sidebarOpen, setSidebarOpen);
  const search = navigation.search, prompt = useRef<HTMLTextAreaElement>(null), scope = useRef(0);
  useEffect(() => { document.documentElement.dataset.theme = theme; writePreference("theme", "unified", "", theme); }, [theme]);
  const openSettings = () => {setArea("assistant"); setHostId(hosts.find(entry => entry.area === "assistant")?.id ?? ""); setConnectionOrigin(null); setSettings(true); setProjects(false); setSidebarOpen(false);};
  const openConnections = () => {setConnectionOrigin("code"); setSettings(true); setProjects(false); setSidebarOpen(false);};
  const closeSettings = () => {setSettings(false); if (connectionOrigin === "code") setProjects(true); setConnectionOrigin(null);};
  const openProjects = () => {setArea("code"); setHostId(hosts.find(entry => entry.area === "code")?.id ?? ""); setProjects(true); setSettings(false); setSidebarOpen(false);};
  useEffect(() => {if (page !== "conversation" || !focusRunId) workspace.current?.focus({preventScroll: true});}, [page, settings, projects, focusRunId]);
  useEffect(() => {
    if (!settings && !projects) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !sidebarOpen) {
        event.preventDefault(); if (settings) closeSettings(); else setProjects(false);
      }
    };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [settings, projects, sidebarOpen, connectionOrigin]);
  const reloadHosts = async (targetArea: "code" | "assistant" = area) => { const next = await window.zhivex.hosts(); setHosts(next); setArea(targetArea); setHostId(next.find(value => value.area === targetArea && value.id === hostId)?.id ?? next.find(value => value.area === targetArea)?.id ?? ""); setSessions([]); setRefresh(value => value + 1); };
  useEffect(() => {setSessionsReady(false); setPaletteOpen(false);}, [hostId, host?.projectId]);
  useEffect(() => { let stopped = false;
    void Promise.all([window.zhivex.hosts(), window.zhivex.setupState().catch(() => 'failed' as const)]).then(([next, setup]) => {
      if (stopped) return;
      const needsSetup = setup === 'failed' || Boolean(setup && !setup.ready);
      const initialHost = needsSetup ? next.find(value => value.area === "assistant") : next.find(value => value.area === "assistant") ?? next[0];
      setHosts(next); setHostId(initialHost?.id ?? ""); setArea(initialHost?.area ?? "assistant");
      setManaged(setup !== null); setSettings(needsSetup);
    }).catch(() => { if (!stopped) setError("Could not connect to your workspace."); });
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    // The first send selects its newly created session without invalidating its own request.
    const continuingSend = firstSendTransition.current?.hostId === hostId && firstSendTransition.current?.sessionId === sessionId;
    firstSendTransition.current = null;
    if (!continuingSend) {scope.current++; setSession(undefined); setRun(undefined);}
    setHistoryRunId(undefined); setFocusRunId(undefined);
    setRenaming(false); setActivity(emptyActivity()); activityRef.current = emptyActivity();
    setDraft(readPreference("draft", host?.projectId ?? hostId, sessionId)); setDraftStored(true); setError(uncertainHosts.current.has(hostId) ? "A result could not be confirmed. Refresh and inspect the conversation before sending again." : ""); setUncertain(uncertainHosts.current.has(hostId));
  }, [hostId, host?.projectId, sessionId]);
  useEffect(() => {
    if (!hostId) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const listing = data(await window.zhivex.command(hostId, {method: 'session.list'}));
        if (stopped) return;
        if (listing.kind === 'sessions') {
          setSessions(listing.sessions);
          setSessionsReady(true);
          if (!listing.sessions.some(value => value.sessionId === sessionId)) {
            const nextId = listing.sessions[0]?.sessionId ?? '';
            if (nextId !== sessionId && !lock.current) {setSessionId(nextId); return;}
          }
        }
        const [snapshot, events] = await Promise.all([
          sessionId ? window.zhivex.command(hostId, { method: "session.get", sessionId }).then(data) : undefined,
          sessionId ? window.zhivex.events(hostId, sessionId, activityRef.current.cursor) : undefined,
        ]);
        if (stopped) return;
        if (snapshot?.kind === "session") {
          setSession(snapshot.session);
          const latest = snapshot.session.runs.at(-1);
          if (latest) { const result = data(await window.zhivex.command(hostId, { method: "run.get", sessionId, runId: latest.runId })); if (stopped) return; if (result.kind === "run") setRun(result.run); }
          else setRun(undefined);
        }
        if (events) { activityRef.current = applyActivityPage(activityRef.current, events); setActivity(activityRef.current); }
        setDisconnected(false);
      } catch {
        if (!stopped) {
          setDisconnected(true);
          // Only reconnect the transport. Uncertain mutations still require reconciliation.
          try { await window.zhivex.reconnect(hostId); } catch {}
        }
        if (!stopped) { timer = setTimeout(() => void poll(), 3000); return; }
      }
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? 3000 : 650);
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [hostId, host?.projectId, sessionId, refresh]);
  const changeDraft = (value: string) => { setDraft(value); setDraftStored(writePreference("draft", host?.projectId ?? hostId, sessionId, value)); };
  const create = useCallback(async () => {
    if (!hostId || lock.current || disconnected || uncertain) return;
    lock.current = true; setBusy(true); setError(""); const generation = scope.current;
    try {
      const next = data(await window.zhivex.command(hostId, { method: "session.create", idempotencyKey: crypto.randomUUID(), title: "New conversation" }));
      if (generation === scope.current && next.kind === "session") { setSessionId(next.session.sessionId); setSession(next.session); setPage("conversation"); setSettings(false); setProjects(false); setSidebarOpen(false); }
    } catch { uncertainHosts.current.add(hostId); if (generation === scope.current) { setError("Could not confirm the new conversation. Refresh before creating another."); setUncertain(true); } }
    finally { lock.current = false; setBusy(false); }
  }, [hostId, host?.projectId, disconnected, uncertain]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(false); setPaletteOpen(value => !value); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); void create(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [create, navigation.show]);
  async function send(input = draft, allowNew = false) {
    if ((!session && (!allowNew || Boolean(sessionId))) || !sessionsReady || !host || !input.trim() || lock.current || disconnected || uncertain || active(run) || run?.status === "waiting_approval") return;
    setFocusRunId(undefined);
    lock.current = true; setBusy(true); setError(""); const generation = scope.current, submitted = input;
    let target = session;
    try {
      if (!target) {
        const created = data(await window.zhivex.command(hostId, {method: 'session.create', title: 'New conversation', idempotencyKey: crypto.randomUUID()}));
        if (created.kind !== 'session') throw new Error('Unexpected conversation response');
        target = created.session;
        if (generation !== scope.current) return;
        const latestDraft = readPreference('draft', host.projectId, sessionId);
        writePreference('draft', host.projectId, target.sessionId, input === draft ? latestDraft : latestDraft || submitted);
        writePreference('draft', host.projectId, sessionId, '');
        firstSendTransition.current = {hostId, sessionId: target.sessionId};
        setSession(target); setSessionId(target.sessionId); setPage('conversation');
      }
      const result = data(await window.zhivex.command(hostId, { method: "run.start", sessionId: target.sessionId, expectedRevision: target.revision, idempotencyKey: crypto.randomUUID(), prompt: submitted }));
      if (generation === scope.current) { if (result.kind === "run") { setRun(result.run); setSession(result.session); } if (readPreference("draft", host.projectId, target.sessionId) === submitted) {setDraft(""); setDraftStored(writePreference("draft", host.projectId, target.sessionId, ""));} if (target.sessionId !== sessionId) setSessionId(target.sessionId); if (allowNew) setPage("conversation"); setRefresh(value => value + 1); }
    } catch { uncertainHosts.current.add(hostId); if (generation === scope.current) { if (target && target.sessionId !== sessionId) setSessionId(target.sessionId); setUncertain(true); setError("The result could not be confirmed. Your draft is saved. Refresh and inspect the conversation before sending again."); } }
    finally { lock.current = false; setBusy(false); }
  }
  async function reconnect() {
    if (lock.current) return;
    if (!hostId) {
      setBusy(true);
      try {
        const next = await window.zhivex.hosts(), setup = await window.zhivex.setupState();
        const available = next.find(value => value.area === area);
        setHosts(next); setHostId(available?.id ?? ''); setManaged(setup !== null);
        setSettings(area === 'assistant' && Boolean(setup && !setup.ready));
        setProjects(area === 'code' && !available);
        setError(!next.length && !setup ? 'No workspace service is available. Start the service, then retry.' : '');
      } catch {setError('Could not connect to your workspace. Start the service, then retry.');}
      finally {setBusy(false);}
      return;
    }
    lock.current = true; setBusy(true);
    try { await window.zhivex.reconnect(hostId); const result = data(await window.zhivex.command(hostId, { method: "session.list" })); if (result.kind === "sessions") setSessions(result.sessions); uncertainHosts.current.delete(hostId); setUncertain(false); setError(""); setRefresh(value => value + 1); }
    catch { setError("The workspace is unavailable. Keep this window open and reconnect when the service is ready."); }
    finally { lock.current = false; setBusy(false); }
  }
  async function cancel() {
    if (!run || cancellationLock.current) return; cancellationLock.current = true; setCancelling(true);
    try { data(await window.zhivex.command(hostId, { method: "run.cancel", sessionId, runId: run.runId, expectedRevision: run.revision, idempotencyKey: crypto.randomUUID() })); }
    catch { setError("Cancellation could not be confirmed. Refresh to inspect the task."); }
    finally { cancellationLock.current = false; setCancelling(false); }
  }
  function selectHost(id: string) { const selected = hosts.find(entry => entry.id === id); if (!selected) return; setArea(selected.area); setConnectionOrigin(null); setSettings(false); setProjects(false); setSidebarOpen(false); if (id === hostId) return; setHostId(id); setSessions([]); setSidebarOpen(false); }
  const waiting = run?.status === "waiting_approval";
  const turnModel = session?.runs.find(entry => entry.runId === run?.runId)?.model;
  const pendingSessions = sessions.filter(entry => entry.runs.at(-1)?.status === "waiting_approval");
  const destinations: {id: NavigationPage; label: string; Icon: typeof House}[] = [
    ...(managed && host?.area === 'assistant' ? [{id: 'today' as const, label: 'Today', Icon: House}] : []),
    {id: 'conversation', label: area === 'assistant' ? 'Conversations' : 'Workspace', Icon: MessageSquare},
    ...(managed && host?.area === 'assistant' ? [{id: 'agenda' as const, label: 'Agenda', Icon: CalendarDays}, {id: 'personal' as const, label: 'Tasks & reminders', Icon: CheckCheck}, {id: 'automations' as const, label: 'Automations', Icon: Zap}, {id: 'notes' as const, label: 'Notes', Icon: MessageSquare}, {id: 'proactive' as const, label: 'Proactive alerts', Icon: Zap}, {id: 'drafts' as const, label: 'Mail drafts', Icon: MessageSquare}] : []),
    {id: 'review', label: area === 'assistant' ? 'Review actions' : 'Changes', Icon: ShieldCheck},
    ...(host?.area === 'code' ? (['worktrees', 'checkpoints', 'execution', 'context', 'git'] as const).map(id => ({id, label: id === 'git' ? 'Git delivery' : id[0]!.toUpperCase() + id.slice(1), Icon: Code2})) : []),
    {id: 'history', label: 'Decision history', Icon: History},
  ];
  const go = (destination: NavigationPage) => {if (destination === "history") setHistoryRunId(undefined); setPage(destination); setSidebarOpen(false); setSettings(false); setProjects(false);};
  const paletteItems: PaletteItem[] = [...destinations.map(item => ({id: item.id, label: item.label, group: area === 'code' ? 'Code' : 'Assistant', run: () => go(item.id)})),
    ...sessions.map(entry => ({id: `session:${entry.sessionId}`, label: `${conversationTitle(entry)} · ${conversationStatus(entry)}`, group: 'Conversations', run: () => {setSessionId(entry.sessionId); go('conversation');}})),
    ...(managed ? [{id: 'settings', label: 'Assistant settings', group: 'Settings', run: openSettings}, {id: 'projects', label: 'Code projects', group: 'Settings', run: openProjects}] : []),
    {id: 'appearance', label: theme === 'dark' ? 'Light appearance' : 'Dark appearance', group: 'Appearance', run: () => setTheme(theme === 'dark' ? 'light' : 'dark')},
  ];
  const visibleArea = area;
  const pageTitle = page === 'review' ? (area === 'assistant' ? 'Review actions' : 'Changes') : page === 'history' ? 'Decision history' : session && session.sessionId === sessionId ? conversationTitle(session) : visibleArea === 'assistant' ? 'What’s on your mind?' : 'Let’s make something work.';
  const missingConversation = !host || !session || session.sessionId !== sessionId;
  const visibleSessions = findConversations(sessions, filter, pendingOnly);
  const firstConversation = Boolean(host && sessionsReady && !sessionId && !session);
  const editorReady = Boolean(host && sessionsReady && (!sessionId || session));
  useEffect(() => {
    if (page === 'conversation' && !focusRunId && !settings && !projects && editorReady) prompt.current?.focus();
  }, [hostId, sessionId, page, settings, projects, editorReady, focusRunId]);
  const prerequisite = <EmptyState title={!host ? area === 'code' ? 'Open a Code project to get started' : 'Connect a model to start a conversation' : 'Start a conversation'}
    action={!host ? managed ? <button onClick={area === "code" ? openProjects : openSettings}>{area === "code" ? "Set up Code project" : "Set up model connection"}</button> : <button onClick={() => void reconnect()} disabled={busy}>Retry connection</button> : <button onClick={() => void create()} disabled={busy || disconnected || uncertain}>New conversation</button>}>
    {!host ? managed ? area === 'code' ? 'Choose a model connection and a Git repository for your Code conversations.' : 'Add your provider, model and API key. You can connect other apps later.' : 'Connect the workspace service to load your conversations, then retry.' : 'Create a conversation to work on a task and keep its changes and decisions together.'}
  </EmptyState>;
  return <div className="unified-shell">
    <aside ref={navigation.sidebar} id="workspace-navigation" className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Workspace navigation" role={navigation.compact && sidebarOpen ? "dialog" : undefined} aria-modal={navigation.compact && sidebarOpen ? true : undefined} inert={navigation.compact && !sidebarOpen} tabIndex={-1}>
      <button className="secondary mobile-menu" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>Close navigation</button>
      <div className="brand"><img src="./zhivex-logo.png" alt="" /><strong>zhivex</strong><span className="badge">Desktop</span></div>
      <div className="area-switch" aria-label="Workspace area">{(["assistant", "code"] as const).map(area => <button key={area} aria-pressed={visibleArea === area} className={visibleArea === area ? "selected" : ""} disabled={!managed && !hosts.some(entry => entry.area === area)} onClick={() => { const next = hosts.find(entry => entry.area === area); if (next) selectHost(next.id); else if (area === "code") openProjects(); else openSettings(); }}>{area === "assistant" ? <Bot /> : <Code2 />}{area === "assistant" ? "Assistant" : "Code"}</button>)}</div>
      <div className="workspace-label"><span className="eyebrow">YOUR WORKSPACE</span><strong>{host?.label ?? "No workspace connected"}</strong></div>
      <button className="new-conversation" onClick={() => void create()} disabled={!host || busy || disconnected || uncertain}><Plus />New conversation<span className="shortcut">⌘ N</span></button>
      <nav aria-label="Main">{destinations.filter(item => ['conversation', 'review', 'history'].includes(item.id)).map(({id, label, Icon}) => <button key={id} className={page === id && !settings && !projects ? 'selected' : ''} aria-current={page === id && !settings && !projects ? 'page' : undefined} onClick={() => go(id)}><Icon />{label}{id === 'review' && pendingSessions.length ? <span className="count" aria-label={`${pendingSessions.length} conversation${pendingSessions.length === 1 ? "" : "s"} awaiting review`}>{pendingSessions.length}</span> : null}</button>)}</nav>
      <div className="sidebar-section"><span className="eyebrow">CONVERSATIONS</span><Search size={14} /></div>
      <label className="search-field"><span className="sr-only">Search conversations</span><input ref={search} value={filter} placeholder="Search conversations…" onChange={event => setFilter(event.target.value)} /></label>
      <button className="ghost conversation-filter" aria-pressed={pendingOnly} onClick={() => setPendingOnly(value => !value)}>Needs review{pendingSessions.length ? ` (${pendingSessions.length})` : ''}</button>
      <div className="session-list" aria-label="Saved conversations">{visibleSessions.map(entry => <button key={entry.sessionId} data-session-id={entry.sessionId} title={conversationTitle(entry)} aria-current={sessionId === entry.sessionId ? 'page' : undefined} className={sessionId === entry.sessionId ? "selected" : ""} onClick={() => { setSessionId(entry.sessionId); go("conversation"); }}><MessageSquare size={14} /><span className="session-summary"><strong>{conversationTitle(entry)}</strong><small>{conversationStatus(entry)} · {new Date(entry.updatedAt).toLocaleDateString()}</small>{readPreference('draft', host?.projectId ?? hostId, entry.sessionId) ? <small>Draft saved</small> : null}</span></button>)}
        {!visibleSessions.length && sessionsReady ? <div className="session-empty"><p role="status">{sessions.length ? 'No matching conversations.' : 'No saved conversations yet.'}</p>{filter || pendingOnly ? <button className="secondary" onClick={() => {setFilter(''); setPendingOnly(false);}}>Show all conversations</button> : null}</div> : null}
      </div>
      {destinations.some(item => !['conversation', 'review', 'history'].includes(item.id)) ? <details className="sidebar-tools" key={area}>
        <summary>{area === 'assistant' ? 'Assistant tools' : 'Code tools'}{!['conversation', 'review', 'history'].includes(page) ? ` · ${destinations.find(item => item.id === page)?.label ?? ''}` : ''}</summary>
        <nav aria-label={area === 'assistant' ? 'Assistant tools' : 'Code tools'}>{destinations.filter(item => !['conversation', 'review', 'history'].includes(item.id)).map(({id, label, Icon}) => <button key={id} className={page === id && !settings && !projects ? 'selected' : ''} aria-current={page === id && !settings && !projects ? 'page' : undefined} onClick={event => {go(id); const menu = event.currentTarget.closest('details'); if (menu) menu.open = false;}}><Icon />{label}</button>)}</nav>
      </details> : null}
      <div className="sidebar-footer">{managed ? <><button className={settings ? "ghost selected" : "ghost"} aria-current={settings ? "page" : undefined} onClick={openSettings}><Bot />Assistant settings</button><button className={projects ? "ghost selected" : "ghost"} aria-current={projects ? "page" : undefined} onClick={openProjects}><Code2 />Code projects</button></> : null}<button className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun /> : <Moon />}{theme === "dark" ? "Light appearance" : "Dark appearance"}</button></div>
    </aside>
    {navigation.compact && sidebarOpen ? <div className="navigation-backdrop" aria-hidden="true" onClick={() => setSidebarOpen(false)} /> : null}
    <main ref={workspace} tabIndex={-1} aria-label="Workspace content" className="workspace" inert={navigation.compact && sidebarOpen}><header className="toolbar"><div className="row"><button ref={navigation.toggle} className="ghost mobile-menu" aria-label="Toggle navigation" aria-controls="workspace-navigation" aria-expanded={sidebarOpen && navigation.compact} onClick={() => navigation.show()}><PanelLeft /></button>{visibleArea === "assistant" ? <Bot size={17} /> : <Code2 size={17} />}<span>{host?.label ?? "Zhivex"}</span><span className="muted">/</span><strong>{settings ? connectionOrigin === "code" ? "Model connection" : "Assistant settings" : projects ? "Code projects" : destinations.find(item => item.id === page)?.label ?? "Workspace"}</strong></div><div className="toolbar-actions"><button className="ghost" aria-label="Search pages and conversations" aria-keyshortcuts="Meta+K Control+K" onClick={() => setPaletteOpen(true)}><Search size={17}/></button><button className="secondary" onClick={() => void reconnect()} disabled={!host || busy}>Refresh</button></div></header>
      {error || disconnected ? <Notice>{error || "The workspace connection was interrupted. Your conversation and draft are preserved."}</Notice> : null}
      {settings || projects ? <div className="settings-content">{settings ? <AssistantSetup returnToCode={connectionOrigin === "code"} onReady={() => reloadHosts(connectionOrigin ?? "assistant")} onClose={closeSettings} /> : <CodeProjects onReady={() => reloadHosts("code")} onClose={() => setProjects(false)} onConnections={openConnections} />}</div> : <div className={`work-area ${page === 'today' ? 'today-layout' : ''}`}><div className="primary-content">
        {host?.area === 'assistant' && page === 'proactive' ? <Proactive key={host.projectId} projectId={host.projectId} disabled={busy || disconnected || uncertain || active(run) || Boolean(waiting)} onAsk={async input => {await send(input, true); setPage('review');}} onSettings={openSettings} /> : null}
        {host?.area === 'assistant' && page === 'drafts' ? <MailDrafts key={host.projectId} projectId={host.projectId} disabled={busy || disconnected || uncertain || active(run) || Boolean(waiting)} onAsk={async input => {await send(input, true); setPage('review');}} onSettings={openSettings} /> : null}
        {host?.area === 'assistant' && page === 'notes' ? <Notes key={host.projectId} projectId={host.projectId} disabled={!session || busy || disconnected || uncertain || active(run) || Boolean(waiting)} onAsk={async input => {await send(input); setPage('review');}} onSettings={() => setSettings(true)} /> : null}
        {host?.area === 'assistant' && page === 'today' ? <AssistantToday key={host.projectId} projectId={host.projectId} sessions={sessions} sessionsReady={sessionsReady} disconnected={disconnected} onAgenda={() => go('agenda')} onTasks={() => go('personal')} onAutomations={() => go('automations')} onSettings={() => setSettings(true)} onReview={id => {setSessionId(id); go('review');}} onConversation={() => go('conversation')} /> : null}
        {host?.area === 'assistant' && page === 'agenda' ? <Today key={host.projectId} projectId={host.projectId} disabled={!session || busy || disconnected || uncertain || active(run) || Boolean(waiting)} onAsk={async input => {await send(input); setPage('review');}} onSettings={() => setSettings(true)} onTasks={() => setPage('personal')} /> : null}
        {host?.area === 'assistant' && page === 'automations' ? <Automations key={host.projectId} projectId={host.projectId} onSettings={() => setSettings(true)} /> : null}
        {host?.area === 'assistant' && page === 'personal' ? <Personal key={host.projectId} projectId={host.projectId} hasSession={Boolean(session)} disabled={!session || busy || disconnected || uncertain || active(run) || Boolean(waiting)} onAsk={async input => {await send(input); setPage('review');}} onSettings={() => setSettings(true)} onConversation={() => setPage('conversation')} /> : null}
        {host?.area === 'code' && page === 'git' ? <section className="panel code-tools"><h2>Git delivery</h2><GitPanel key={host.projectId} bridge={window.zhivex} projectKey={host.projectId} disabled={busy || disconnected || uncertain || active(run) || Boolean(waiting)} /></section> : null}
        {host?.area === 'code' && page === 'worktrees' ? <Worktrees key={host.projectId} onOpen={async () => {await reloadHosts('code'); setPage('conversation');}} /> : null}
        {host?.area === 'code' && page === 'checkpoints' ? session ? <CheckpointPanel key={`${host.projectId}:${sessionId}`} bridge={window.zhivex} projectKey={hostId} session={session} disabled={busy || disconnected || uncertain || active(run) || Boolean(waiting)} onOpen={async id => {setSessionId(id); setPage('conversation'); setRefresh(value => value + 1);}} /> : <p>Create a conversation and complete a turn before capturing files.</p> : null}
        {host?.area === 'code' && page === 'context' ? <CodeContext key={host.projectId} projectId={host.projectId} /> : null}
        {host?.area === 'code' && page === 'execution' ? <Execution key={host.projectId} cancelling={cancelling} disabled={!session || busy || disconnected || uncertain || active(run) || Boolean(waiting)} run={run} onRun={input => send(input)} onReview={() => setPage('review')} onCancel={() => void cancel()} onConversation={() => setPage('conversation')} /> : null}
        <div className="page-heading" hidden={['proactive', 'drafts', 'notes', 'today', 'agenda', 'automations', 'personal', 'worktrees', 'checkpoints', 'execution', 'context', 'git'].includes(page)}><div className="eyebrow">{visibleArea === "assistant" ? "ASSISTANT" : "CODE"}</div><h1>{pageTitle}</h1><p>{page === "conversation" ? "A focused conversation. Clear decisions. Work that stays with you." : page === "review" ? "See exactly what will change, then decide." : "Every decision, in context."}</p></div>
        {session && page === "conversation" ? <button className="ghost rename-trigger" disabled={busy || disconnected || uncertain} onClick={() => setRenaming(true)}>Rename conversation</button> : null}
        <div className="conversation-scroll" hidden={!['conversation', 'review', 'history'].includes(page)}>
          {host && sessionId && missingConversation ? <p role="status">Loading the selected conversation…</p> : missingConversation && !(host && page === 'conversation') ? prerequisite : null}
          {host && page === 'conversation' && !session ? firstConversation ? <div className="welcome panel"><MessageSquare /><h2>Your model is connected.</h2><p>Write your first message below. Your conversation is saved automatically when you send.</p><button className="secondary" disabled={busy || disconnected || uncertain} onClick={() => {changeDraft('What can you help me with?'); prompt.current?.focus();}}>What can you help me with? <ArrowUp size={14}/></button></div> : <p role="status">Loading your conversation…</p> : null}
          {!missingConversation && page === "conversation" ? <>{activity.order.length ? <Conversation activity={activity} currentRun={run} focusRunId={focusRunId} assistantLabel="ZHIVEX" onHistory={id => {setHistoryRunId(id); setPage("history");}} onRefresh={() => void reconnect()} /> : busy ? <p role="status">Sending your message…</p> : <div className="welcome panel"><MessageSquare /><h2>{sessionId ? "Start with an idea." : "A fresh place to begin."}</h2><p>{sessionId ? "Your messages and decisions will stay in this conversation, in the app and terminal." : "Create a conversation to get started, or select one from the sidebar."}</p>{sessionId ? <button className="secondary" onClick={() => { changeDraft(host?.area === "assistant" ? "Help me plan my day." : "Help me understand this workspace."); prompt.current?.focus(); }}>{host?.area === "assistant" ? "Plan my day" : "Understand this workspace"} <ArrowUp size={14} /></button> : <button disabled={!host || busy} onClick={() => void create()}>New conversation</button>}</div>}
            {waiting ? <div className="approval-callout"><ShieldCheck /><div><strong>An action needs your review.</strong><p>The task is waiting for your decision.</p></div><button onClick={() => setPage("review")}>Review action</button></div> : null}</> : null}
          {page === 'review' && pendingSessions.some(entry => entry.sessionId !== sessionId) ? <section className="panel pending-reviews" aria-label="Other conversations awaiting review"><h2>Other conversations awaiting review</h2><p>Select a conversation to inspect its request before deciding.</p>{pendingSessions.filter(entry => entry.sessionId !== sessionId).map(entry => <button className="secondary" key={entry.sessionId} onClick={() => setSessionId(entry.sessionId)}>{conversationTitle(entry)}</button>)}</section> : null}
          {!missingConversation && page === "review" ? waiting && run ? <Review key={`${hostId}:${sessionId}:${run.runId}`} hostId={hostId} sessionId={sessionId} runId={run.runId} revision={run.revision} blocked={uncertain} onUncertain={() => { uncertainHosts.current.add(hostId); setUncertain(true); }} onRefresh={() => { void reconnect(); setPage("conversation"); }} onDecision={() => { setFocusRunId(undefined); setRefresh(value => value + 1); setPage("conversation"); }} /> : <EmptyState title="No actions awaiting review">Requests appear here when a task in this conversation needs your approval.</EmptyState> : null}
          {page === "history" && !missingConversation && session ? <DecisionHistory key={`${host?.projectId}:${sessionId}:${historyRunId ?? "latest"}`} hostId={hostId} session={session} initialRunId={historyRunId} onConversation={id => {setFocusRunId(id); setPage("conversation");}} onReview={() => setPage("review")} /> : null}
        </div>
        {host && (page === "today" || page === "conversation") ? <MessageEditor inputRef={prompt} value={draft}
          placeholder={page === 'today' ? 'Ask about your day, plan a task, or prepare a draft.' : 'Describe what you’d like to do…'}
          disabled={!editorReady}
          sendDisabled={!host || !sessionsReady || (!session && Boolean(sessionId)) || !draft.trim() || busy || disconnected || uncertain || Boolean(waiting) || active(run)}
          sending={busy && !active(run)} running={active(run)} cancelling={cancelling} waiting={Boolean(waiting)} stored={draftStored}
          onChange={changeDraft} onSend={() => void send(draft, !sessionId)} onCancel={() => void cancel()} /> : null}
      </div>{!missingConversation && session && ["conversation", "review", "history"].includes(page) ? <aside className="context-panel" aria-label="Conversation context"><span className="eyebrow">IN THIS CONVERSATION</span><h3>One shared workspace</h3><p>The app and terminal see the same messages, tasks and decisions.</p><div className="context-row"><span>Latest task</span><strong>{run?.status?.replaceAll("_", " ") ?? "Not started"}</strong></div><div className="context-row"><span>Review</span><strong>{disconnected ? "Unavailable" : waiting ? "Required" : "No pending action in this conversation"}</strong></div>{turnModel ? <div className="context-row"><span>Model for this turn</span><strong>{turnModel}</strong></div> : null}{host?.area === "code" ? <button className="secondary" onClick={() => go("context")}>View working context</button> : null}<div className="context-note"><ShieldCheck /><p>You stay in control. An approval applies only to the action you reviewed.</p></div></aside> : null}</div>}
      <footer className="statusbar"><span>Zhivex</span><span>Local workspace</span><span role="status"><span className={`status-dot ${!host || disconnected ? "offline" : ""}`} />{!host ? "Not connected" : disconnected ? "Connection unavailable" : "Connected"}</span></footer>
    </main>
    {renaming && session ? <RenameConversation key={`${host?.projectId}:${sessionId}`} hostId={hostId} session={session} onClose={() => setRenaming(false)} onSaved={() => {setRenaming(false); setRefresh(value => value + 1);}} /> : null}
    {paletteOpen ? <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} /> : null}
  </div>;
}
