import {Button} from './ui.js';
import { useEffect, useState } from 'react';
import type { CodeProjectState } from '@zhivex-ai/harness/application/protocol';
import type { AssistantSetupState } from './bridge.js';

export function CodeProjects({ onReady, onClose, onConnections }: { onReady(): Promise<void>; onClose(): void; onConnections(): void }) {
  const [state, setState] = useState<CodeProjectState | null>(null), [connections, setConnections] = useState<AssistantSetupState['connections']>([]);
  const [connectionId, setConnectionId] = useState(''), [busy, setBusy] = useState(true), [error, setError] = useState('');
  useEffect(() => { let disposed = false;
    void window.zhivex.catalog().then(catalog => {
      if (catalog?.locked) throw new Error('SETUP_KEYCHAIN_UNAVAILABLE');
      const code = catalog?.projects ?? null, setup = catalog;
      if (disposed) return; setState(code); setConnections(setup?.connections ?? []); setConnectionId(code?.projects.find(project => project.id === code.active)?.connectionId ?? setup?.connections[0]?.id ?? '');
    }).catch(failure => { if (!disposed) setError(failure.message); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function operate(action: () => Promise<CodeProjectState | null>) {
    if (busy) return; setBusy(true); setError('');
    try { const next = await action(); if (next) { setState(next); await onReady(); if (next.ready) onClose(); } }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open the project.'); }
    finally { setBusy(false); }
  }
  const failure = error || state?.error || '';
  const gitFailure = failure.includes('CODE_GIT_');
  const failureMessage = failure.includes('CODE_GIT_ROOT_REQUIRED') ? 'Select the repository root, not a subfolder.'
    : failure.includes('CODE_GIT_REQUIRED') ? 'This folder is not a Git working tree. Choose an existing repository; no files were changed.'
    : failure.includes('CODE_GIT_UNAVAILABLE') ? 'Git could not be found. Install Git and reopen Zhivex.' : failure;
  return <section className="setup-panel panel" aria-label="Code projects">
    <div className="row"><h1>{connections.length ? "Your Code projects" : "Connect a model for Code"}</h1>{state?.ready ? <Button variant="secondary" onClick={onClose} disabled={busy}>Back to Code</Button> : null}</div>
    <p>{connections.length ? "Choose the root folder of a Git repository or worktree. Each project keeps its own conversations. File changes need your review." : "Connect a model first. You’ll return here to choose your Git repository or worktree."}</p>
    {failure ? <div className="notice" role="alert">{failureMessage}{!gitFailure ? <p>Finish or cancel active tasks and resolve pending reviews before changing projects. If the runtime stopped, retry below.</p> : null}</div> : null}
    {error || state?.error ? <Button disabled={busy} onClick={() => void operate(() => window.zhivex.retryCode())}>Retry Code startup</Button> : null}
    {connections.length ? <form onSubmit={event => { event.preventDefault(); void operate(() => window.zhivex.openCode(connectionId)); }}>
      <label>Model connection<select value={connectionId} onChange={event => setConnectionId(event.target.value)}>{connections.map(connection => <option value={connection.id} key={connection.id}>{connection.label} · {connection.model}</option>)}</select></label>
      <div className="project-actions"><Button type="submit" disabled={busy || !connectionId}>Choose project folder</Button><Button variant="secondary" onClick={onConnections} disabled={busy}>Manage connections</Button></div>
    </form> : <p>The same saved connection can be used in Assistant and Code.</p>}
    {state?.ready && state.active && connections.length ? <div className="notice">
      <p>Apply the selected model connection to the active project. Finish active tasks and pending reviews first. Earlier turns retain their recorded model.</p>
      <Button disabled={busy || !connectionId || state.projects.find(project => project.id === state.active)?.connectionId === connectionId} onClick={() => void operate(() => window.zhivex.configureCode(state.active!, connectionId))}>Use selected connection for this project</Button>
    </div> : null}
    {!connections.length ? <Button onClick={onConnections} disabled={busy}>Set up model connection</Button> : null}
    <div className="agent-list">{state?.projects.map(project => <div className="row" key={project.id}><div><strong>{project.label}</strong><p style={{overflowWrap: 'anywhere'}}>{project.workspace}</p></div><Button variant="secondary" disabled={busy} onClick={() => void operate(() => window.zhivex.selectCode(project.id))}>{state.active === project.id && state.ready ? 'Continue project' : 'Open project'}</Button></div>)}</div>
    {busy ? <p role="status">Opening your workspace…</p> : null}
  </section>;
}
