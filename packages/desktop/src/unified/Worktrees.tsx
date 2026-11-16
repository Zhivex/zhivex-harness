import { useEffect, useRef, useState } from 'react';
import type { ManagedTask, TaskRemovalReview, CodeProjectState } from '@zhivex-ai/harness/application';

export function Worktrees({ onOpen }: { onOpen(): Promise<void> }) {
  const [tasks, setTasks] = useState<ManagedTask[]>([]), [state, setState] = useState<CodeProjectState | null>(null);
  const [title, setTitle] = useState(''), [branch, setBranch] = useState('');
  const [review, setReview] = useState<TaskRemovalReview>(), [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), mounted = useRef(true);
  const load = async () => { setLoading(true); try { const [items, code] = await Promise.all([window.zhivex.worktrees(), window.zhivex.codeState()]); if (mounted.current) { setTasks(items); setState(code); } } finally { if (mounted.current) setLoading(false); } };
  useEffect(() => { mounted.current = true; void load().catch(error => { if (mounted.current) setError(error.message); }); return () => { mounted.current = false; }; }, []);
  const act = async (fn: () => Promise<void>) => { if (pending.current) return; pending.current = true; setBusy(true); setError(''); try { await fn(); } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not complete the operation.'); } finally { pending.current = false; if (mounted.current) setBusy(false); } };
  const current = state?.projects.find(project => project.id === state.active);
  const parentPath = tasks.find(task => task.workspace === current?.workspace)?.sourceWorkspace;
  const parent = state?.projects.find(project => project.workspace === parentPath);
  return <section className="panel code-tools" aria-label="Worktrees"><h2>Work in a separate checkout</h2>
    <p>Starts from the current committed HEAD on a new feat/ branch. Uncommitted changes stay in the source folder.</p>
    {error ? <p className="notice" role="alert">{error} · Reload before retrying an uncertain operation.</p> : null}
    <button className="secondary" disabled={busy || loading} onClick={() => void act(load)}>Reload worktrees</button>
    {parent ? <button className="secondary" disabled={busy || loading} onClick={() => void act(async () => { await window.zhivex.selectCode(parent.id); await onOpen(); })}>Back to source project</button> : null}
    <form onSubmit={event => {event.preventDefault(); void act(async () => { await window.zhivex.createWorktree({title, ...(branch.trim() ? {branch: branch.trim()} : {}), initialState: 'committed-head'}); setTitle(''); setBranch(''); await load(); });}}>
      <label>Worktree title<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Branch (optional)<input placeholder="feat/my-task" value={branch} onChange={event => setBranch(event.target.value)} /></label>
      <button disabled={busy || !title.trim()}>Create worktree</button>
    </form>
    {loading ? <p role="status">Loading worktrees…</p> : !error && tasks.every(task => task.status === 'removed') ? <p>No managed worktrees yet. Create one to work in a separate checkout.</p> : null}
    {tasks.filter(task => task.status !== 'removed').map(task => <article key={task.id}><h3>{task.title}</h3><p>{task.branch} · {task.status}</p><p>{task.error}</p><div className="row"><button disabled={busy || task.status !== 'ready'} onClick={() => void act(async () => { await window.zhivex.openWorktree(task.id); await onOpen(); })}>Open worktree</button><button className="secondary" disabled={busy || task.status !== 'ready' || current?.workspace === task.workspace} onClick={() => void act(async () => { setReview(await window.zhivex.reviewWorktreeRemoval(task.id)); setAccepted(false); })}>Review removal</button></div></article>)}
    {review ? <section aria-label="Review worktree removal"><h3>Remove {review.task.title}?</h3><p>{review.task.workspace}</p><p>{review.changedPaths.length} changed paths · {review.unmergedCommits} unmerged commits · {review.locked ? 'Locked' : 'Unlocked'}</p>{review.changedPaths.map(value => <pre key={value}>{value}</pre>)}<p>The branch and saved conversation state are retained. Removal is blocked for dirty, ignored, locked or unmerged work.</p><label className="row"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />I reviewed this checkout and its removal.</label><button disabled={busy || !review.canRemove || !accepted} onClick={() => void act(async () => { const ticket = review.ticketId; setReview(undefined); await window.zhivex.removeWorktree(ticket); await load(); })}>Confirm removal</button><button className="secondary" onClick={() => setReview(undefined)}>Cancel</button></section> : null}
  </section>;
}
