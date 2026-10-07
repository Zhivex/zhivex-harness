import { useEffect, useRef, useState } from 'react';
import { reduceHarnessTaskProjection, type HarnessTaskProjection, type HarnessClientData } from '@zhivex-ai/harness/protocol';
import { action } from './api.js';
import type { HarnessClientRun, HarnessClientSession, WebWorkspace } from './contracts.js';
import './task-panel.css';

type TaskData = Extract<HarnessClientData, { kind: 'task' }>;
type Review = Extract<HarnessClientData, { kind: 'taskReview' }>['review'];
type Response = { data: HarnessClientData };
const amount = (value: number | null | undefined) => value == null ? 'Unknown' : value.toLocaleString('en-US');
const usd = (value: number | null | undefined) => value == null ? 'Unknown' : '$' + value.toFixed(6);
const terminal = (value: string) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(value);

export function TaskPanel({ workspace, session, run, enabled, connected, prompt, perform, onResult, onTask }: {
  workspace: WebWorkspace; session: HarnessClientSession; run?: HarnessClientRun; enabled: boolean; connected: boolean; prompt: string;
  perform: (label: string, work: () => Promise<void>, mutation?: boolean) => Promise<void>;
  onResult: (data: HarnessClientData) => void; onTask: (present: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<HarnessTaskProjection | null>(null);
  const snapshotRef = useRef(snapshot);
  const [humanDecision, setHumanDecision] = useState<TaskData['humanDecision']>();
  const [error, setError] = useState('');
  const [review, setReview] = useState<Review>();
  const [reviewMode, setReviewMode] = useState<'view' | 'revise' | 'continue'>('view');
  const [text, setText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [defining, setDefining] = useState(false);
  const [goal, setGoal] = useState(prompt);
  const [paths, setPaths] = useState('');
  const [checks, setChecks] = useState('test');
  const [budget, setBudget] = useState({ inputTokens: '', outputTokens: '', totalTokens: '' });
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const protocol = workspace.taskProtocol;
  const runId = run?.runId;
  useEffect(() => {
    snapshotRef.current = null; setSnapshot(null); setReview(undefined); setHumanDecision(undefined); setError('');
  }, [runId]);
  useEffect(() => {
    if (!runId || !protocol || !connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const scope = { connectionId: protocol.connectionId, projectId: protocol.projectId, sessionId: session.sessionId, runId };
    async function read() {
      try {
        const result = await action<{ data: TaskData }>(workspace.key, 'task', { sessionId: session.sessionId, runId });
        if (stopped) return;
        const next = reduceHarnessTaskProjection(snapshotRef.current, result.data.projection, scope);
        if (next.status === 'refresh_required') throw Error('TASK_VIEW_CHANGED');
        if (next.status === 'applied') {
          snapshotRef.current = next.snapshot; setSnapshot(next.snapshot); setHumanDecision(result.data.humanDecision);
          onTask(true); setDefining(false); setError('');
        }
      } catch {
        if (!stopped) setError('Task evidence is unavailable. Refresh the host state before deciding. Ordinary chat may have no task contract.');
      } finally { if (!stopped) timer = setTimeout(() => void read(), 1000); }
    }
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [workspace.key, protocol, session.sessionId, runId, connected, onTask]);
  useEffect(() => {
    if (!review && !defining) return;
    heading.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review, defining]);
  const task = snapshot?.task;
  const valid = Boolean(review && task && review.expiresAt > now && connected && !error &&
    review.projection.task.runRevision === task.runRevision && review.projection.task.contractDigest === task.contractDigest &&
    review.projection.task.artifact.observedDigest === task.artifact.observedDigest && review.projection.task.budget.revision === task.budget.revision);
  const close = () => { setReview(undefined); setDefining(false); setText(''); setConfirmed(false); opener.current?.focus(); };
  async function inspect() {
    if (!run || !enabled) return;
    await perform('Reading task review…', async () => {
      const response = await action<Response>(workspace.key, 'taskReview', { sessionId: session.sessionId, runId: snapshotRef.current?.task.observedRunId ?? run.runId });
      if (response.data.kind !== 'taskReview') throw Error('REVIEW_REQUIRED');
      setReview(response.data.review); setReviewMode('view'); setConfirmed(false); setText(''); setNow(Date.now());
    });
  }
  async function decide(kind: 'Keep' | 'Revise' | 'Continue') {
    if (!review || !valid || !enabled) return;
    const ticket = review;
    setReview(undefined); setConfirmed(false);
    await perform(kind === 'Continue' ? 'Starting task…' : 'Saving task decision…', async () => {
      const response = await action<Response>(workspace.key, 'task' + kind, { sessionId: session.sessionId, runId: ticket.projection.runId,
        reviewId: ticket.reviewId, idempotencyKey: crypto.randomUUID(), ...(kind === 'Revise' ? { correction: text } : kind === 'Continue' ? { prompt: text } : {}) });
      onResult(response.data);
      if (response.data.kind === 'task') { snapshotRef.current = response.data.projection; setSnapshot(response.data.projection); setHumanDecision(response.data.humanDecision); }
    }, true);
    panel.current?.focus();
  }
  async function start() {
    if (!enabled) return;
    await perform('Starting task…', async () => {
      const current = await action<{ data: { session: HarnessClientSession } }>(workspace.key, 'session', { sessionId: session.sessionId });
      const response = await action<Response>(workspace.key, 'taskStart', { sessionId: session.sessionId, expectedRevision: current.data.session.revision,
        idempotencyKey: crypto.randomUUID(), brief: { goal, paths: paths.split('\n').map(s => s.trim()).filter(Boolean),
          checks: checks.split(',').map(s => s.trim()).filter(Boolean), constraints: [],
          budget: { inputTokens: Number(budget.inputTokens), outputTokens: Number(budget.outputTokens), totalTokens: Number(budget.totalTokens) } } });
      onTask(true); onResult(response.data); setDefining(false);
    }, true);
    panel.current?.focus();
  }
  if (!protocol?.capabilities.includes('task.control.v1')) return <section className="task-panel"><h2>Task evidence</h2><p>This host does not support task controls.</p></section>;
  return <section ref={panel} className="task-panel" id="task-evidence" aria-label="Task evidence" tabIndex={-1}>
    <div className="section-heading"><h2>Task evidence</h2>{task && <span className="count">Revision {task.contractRevision}</span>}</div>
    {!task && !defining && <><p>{run ? error || 'Reading task evidence…' : 'Define an objective, exact files and checks to keep evidence with the task.'}</p>
      {!session.runs.length && <button ref={opener} disabled={!enabled} onClick={() => { setGoal(prompt); setDefining(true); }}>Define task</button>}</>}
    {defining && <form onSubmit={e => { e.preventDefault(); void start(); }}>
      <h3 ref={heading} tabIndex={-1}>Define a governed task</h3>
      <label>Objective<textarea required maxLength={2000} value={goal} onChange={e => setGoal(e.target.value)} /></label>
      <label>Exact editable files, one per line<textarea required value={paths} onChange={e => setPaths(e.target.value)} /></label>
      <label>Package checks, comma separated<input required value={checks} onChange={e => setChecks(e.target.value)} /></label>
      <fieldset><legend>Total task token budget</legend>{(['inputTokens', 'outputTokens', 'totalTokens'] as const).map(name =>
        <label key={name}>{name === 'inputTokens' ? 'Input tokens' : name === 'outputTokens' ? 'Output tokens' : 'Total tokens'}
          <input required type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" value={budget[name]} onChange={e => setBudget({ ...budget, [name]: e.target.value })} /></label>)}</fieldset>
      <p>Uses a clean Git baseline and existing tracked files. Each write and native check still needs exact approval. These tokens cover the whole task, including continuation; the limits control above remains available.</p>
      <div className="task-actions"><button type="button" onClick={close}>Back</button><button className="primary" disabled={!enabled}>Start governed task</button></div>
    </form>}
    {task && <>
      {task.historicalRequest && run?.status === 'failed' && <p role="status">This attempt failed. Showing the last admitted task evidence; review it again before another decision.</p>}
      <p className="task-objective">{task.objective ?? 'Objective unavailable'}</p>
      <div className="task-statuses" aria-label="Task status"><span>Execution: {task.execution.replaceAll('_', ' ')}</span>
        <span>Checks: {task.review.structure === 'verified' ? 'verified for these bytes' : 'incomplete or stale'}</span>
        <span>Human acceptance: {humanDecision?.status === 'current' ? 'recorded for this snapshot' : humanDecision?.status === 'stale' ? 'stale — review again' : 'pending'}</span></div>
      <p className="task-next" role="status">{task.effects.unknown || task.effects.missingEvidence ? 'Effects are uncertain. Reconcile before further work; nothing will replay automatically.'
        : task.execution === 'cancel_requested' ? 'Cancellation requested; local completion is not confirmed.'
        : task.execution === 'cancelled' ? 'Host recorded cancellation. Provider stop remains unconfirmed; prior effects are retained.'
        : task.nextAction.kind === 'reconcile' ? 'Host evidence requires reconciliation before another decision. Review the blockers and retained usage; nothing will replay automatically.'
        : !terminal(task.execution) ? task.execution === 'waiting_approval' ? 'Review the exact pending operation below.' : 'Host execution is in progress.'
        : humanDecision?.status === 'current' ? 'Acceptance is recorded for these bytes. Review again before correcting or continuing.'
        : task.review.structure === 'verified' ? 'Review the delivery and human requirements before accepting.' : 'Inspect the evidence before an explicit continuation.'}</p>
      {error && <p role="status">{error}</p>}
      <details><summary>Result, checks and provenance</summary>
        <p>Artifact: {task.artifact.correspondence}. Source: durable host contract, journal and fresh native snapshot.</p>
        <ul>{task.artifact.paths.map(p => <li key={p}><code>{p}</code></li>)}</ul>
        <ul>{task.review.checks.map(c => <li key={c.id}>{c.id}: {c.status.replaceAll('_', ' ')} · contract, snapshot and tool journal</li>)}</ul>
        {task.reasons.length > 0 && <p>Host blockers: {task.reasons.join(', ')}.</p>}
        <p>Semantic review remains human work. Engine completion and check success do not mean acceptance.</p>
        <ul>{task.review.human.map(h => <li key={h.id}>{h.requirement}</li>)}</ul>
        <small>Objective source: {task.objectiveSource.replaceAll('_', ' ')}. Run: <code>{task.observedRunId}</code></small>
        <small>Contract: <code>{task.contractDigest}</code></small><small>Observed bytes: <code>{task.artifact.observedDigest ?? 'Unavailable'}</code></small>
      </details>
      <details><summary>Task budget and continuation</summary>
        <p>{task.budget.availability === 'authoritative' ? 'One durable account for this task; do not add these figures to the per-run monitor.' : 'Legacy task: no authoritative task budget is available.'}</p>
        <table><caption>Token accounting</caption><thead><tr><th>Category</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>
          {(['limits', 'confirmed', 'reserved', 'unknown', 'remaining'] as const).map(name => <tr key={name}><th>{name === 'unknown' ? 'Unknown held' : name}</th>
            <td>{amount(task.budget[name]?.inputTokens)}</td><td>{amount(task.budget[name]?.outputTokens)}</td><td>{amount(task.budget[name]?.totalTokens)}</td></tr>)}</tbody></table>
        <p>Confirmed: reported usage. Reserved: admission estimate. Unknown held: exposure retained when actual usage is unresolved. Separate token estimates are not recorded.</p>
        <p>Estimated confirmed cost: {usd(task.budget.monetary.estimatedConfirmedUsd)} · Reserved: {usd(task.budget.monetary.reservedUsd)} · Unknown held: {usd(task.budget.monetary.unknownHeldUsd)} · Remaining: {usd(task.budget.monetary.remainingUsd)}.</p>
        <p>{task.budget.monetary.unknown ? 'Cost is incomplete. ' : ''}Monetary values are estimates, not invoices. Continuation may use remaining tokens for model calls, compaction, approved edits and checks. It preserves earlier consumption and receipts; it never replenishes credit or repeats uncertain effects automatically.</p>
      </details>
      <button ref={opener} disabled={!enabled || !terminal(task.execution) || Boolean(error)} onClick={() => void inspect()}>Review task</button>
    </>}
    {review && <div className="task-confirmation" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <h3 ref={heading} tabIndex={-1}>Review exact delivery</h3>
      <p>Revision {review.projection.task.contractRevision}. This review expires in five minutes and applies only to the displayed run, contract and bytes.</p>
      <pre tabIndex={0} aria-label="Task delivery diff">{review.diff || 'No Git diff in the inspected workspace.'}</pre>
      {!review.complete && <p>Some review content is hidden or truncated. Acceptance is unavailable until the complete evidence can be reviewed.</p>}
      {!valid && <p role="alert">This review changed, expired or disconnected. Close it and read a fresh review.</p>}
      {reviewMode === 'view' ? <>
        <label className="task-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed the diff and all human requirements for this snapshot.</label>
        <div className="task-actions"><button disabled={!enabled || !valid || !confirmed || !review.canKeep} onClick={() => void decide('Keep')}>Accept this snapshot</button>
          <button disabled={!enabled || !valid || !review.canRevise} onClick={() => { setReviewMode('revise'); setText(''); }}>Correct requirements</button>
          <button disabled={!enabled || !valid || !review.canContinue} onClick={() => { setReviewMode('continue'); setText(prompt); }}>Continue task</button></div>
        {!review.canContinue && <p>Execution is blocked by the host evidence or remaining budget. Refresh and reconcile; changing limits cannot restore this task's credit.</p>}
      </> : <>
        <label>{reviewMode === 'revise' ? 'Additional requirement' : 'Continuation instruction'}<textarea autoFocus maxLength={reviewMode === 'revise' ? 500 : 2000} value={text} onChange={e => setText(e.target.value)} /></label>
        <p>{reviewMode === 'revise' ? 'Adds a pending human requirement without running work. Compatible deterministic checks are retained; human acceptance must be reviewed again.' : 'The host rechecks admission and uses the remaining task budget. Existing effects are not replayed; new writes/checks still need approval.'}</p>
        <div className="task-actions"><button onClick={() => { setReviewMode('view'); setText(''); }}>Back to review</button>
          <button disabled={!enabled || !valid || !text.trim()} onClick={() => void decide(reviewMode === 'revise' ? 'Revise' : 'Continue')}>{reviewMode === 'revise' ? 'Save correction' : 'Confirm continuation'}</button></div>
      </>}
      <button className="subtle" onClick={close}>Close review</button>
    </div>}
  </section>;
}
