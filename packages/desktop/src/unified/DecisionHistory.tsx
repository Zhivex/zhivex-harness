import {actionLabel} from "../conversation-feedback.js";
import {conversationTitle} from "./conversation-resume.js";
import {useEffect, useState} from 'react';
import type {HarnessClientRun, HarnessClientSession} from '@zhivex-ai/harness/protocol';

const outcomes: Record<string, string> = {
  rejected: 'Rejected', approved: 'Approved; execution not yet confirmed',
  applied: 'Changes applied', succeeded: 'Succeeded', failed: 'Failed', unknown: 'Outcome unconfirmed',
};

export function DecisionHistory({hostId, session, initialRunId, onConversation, onReview}: {hostId: string; session: HarnessClientSession; initialRunId?: string | undefined; onConversation?(runId: string): void; onReview?(): void}) {
  const [selected, setSelected] = useState(() => initialRunId ?? session.runs.at(-1)?.runId ?? '');
  const [offset, setOffset] = useState(0), [previous, setPrevious] = useState<number[]>([]);
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<HarnessClientRun>(), [error, setError] = useState('');
  const runId = session.runs.some(run => run.runId === selected) ? selected : session.runs.at(-1)?.runId;
  useEffect(() => {
    let disposed = false;
    setSnapshot(undefined); setError(''); setLoading(Boolean(runId));
    if (runId) void window.zhivex.command(hostId, {method: 'run.get', sessionId: session.sessionId, runId, decisionOffset: offset}).then(result => {
      if (!result.ok || result.data.kind !== 'run' || result.data.run.runId !== runId) throw new Error('HISTORY_UNAVAILABLE');
      if (!disposed) setSnapshot(result.data.run);
    }).catch(() => {
      if (!disposed) setError('Could not read these decisions. Retry; unavailable history does not mean no decision was recorded.');
    }).finally(() => {if (!disposed) setLoading(false);});
    return () => {disposed = true;};
  }, [hostId, session.sessionId, session.revision, runId, offset, refresh]);
  const decisions = snapshot?.decisions ?? [];
  const exportPage = () => {
    if (!snapshot || loading || error) return;
    const payload = {schemaVersion: 1, exportedAt: new Date().toISOString(), scope: 'decision-page',
      sessionId: session.sessionId, runId: snapshot.runId, offset, total: snapshot.decisionTotal ?? decisions.length,
      nextOffset: snapshot.decisionNextOffset ?? null, decisions};
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2) + '\n'], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'zhivex-decisions.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return <section className="panel code-tools history-list" aria-label="Decision history">
    <h2>Decision history</h2><p><strong>{conversationTitle(session)}</strong></p><p>Recorded decisions for this conversation. Select an earlier execution to inspect its approvals and outcomes.</p>
    {!session.runs.length ? <p>No executions in this conversation yet.</p> : <>
      <label htmlFor="history-run">Execution history</label><select id="history-run" value={runId} onChange={event => {setSelected(event.target.value); setOffset(0); setPrevious([]);}}>{[...session.runs].reverse().map(run => <option key={run.runId} value={run.runId}>Turn {session.runs.indexOf(run) + 1} · {new Date(run.createdAt).toLocaleString()} · {run.model} · {run.status.replaceAll('_', ' ')}</option>)}</select>
      <div className="row">{onConversation && runId ? <button className="secondary" onClick={() => onConversation(runId)}>View this turn in conversation</button> : null}{snapshot?.status === "waiting_approval" && onReview && runId === session.runs.at(-1)?.runId ? <button onClick={onReview}>Review pending action</button> : null}</div>
      <button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh history</button>
      {loading ? <p role="status">Reading recorded decisions…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {snapshot ? <>
        <button className="secondary" disabled={loading || Boolean(error)} onClick={exportPage}>Export this decision page</button>
        <p>Exports only the displayed page, with its execution and pagination information.</p>
        <p>Execution: {snapshot.status.replaceAll('_', ' ')} · {snapshot.decisionTotal ?? decisions.length} recorded decisions</p>
        {!decisions.length ? <p>{snapshot.status === "waiting_approval" ? "This turn is waiting for your decision. No decision has been recorded yet." : "No recorded decisions on this page. Not every turn requires approval."}</p> : decisions.map(decision => <article className="history-item" key={`${decision.approvalId}:${decision.decidedAt}`}><div>
          <h3>{decision.approved ? 'Action approved' : 'Action rejected'}</h3>
          <p><strong>{actionLabel(decision.name)}</strong> · {outcomes[decision.status] ?? 'Outcome unconfirmed'}</p>
          <time dateTime={new Date(decision.decidedAt).toISOString()}>{new Date(decision.decidedAt).toLocaleString()}</time>
          <p>Origin: {decision.provenance?.origin ?? 'unknown'} · Channel: {decision.provenance?.channel ?? 'unknown'}</p>
          {decision.status === 'unknown' ? <p>The recorded approval does not confirm the effect. Inspect the conversation and reconcile before requesting the action again.</p> : null}
          {decision.evidence?.exitCode !== undefined ? <p>Exit code: {decision.evidence.exitCode}{decision.evidence.timedOut ? ' · Timed out' : ''}</p> : null}
        </div></article>)}
        <div className="row"><button className="secondary" disabled={loading || !previous.length} onClick={() => {setOffset(previous.at(-1)!); setPrevious(value => value.slice(0, -1));}}>Previous decisions</button><button className="secondary" disabled={loading || snapshot.decisionNextOffset === undefined} onClick={() => {setPrevious(value => [...value, offset]); setOffset(snapshot.decisionNextOffset!);}}>More decisions</button></div>
      </> : null}
    </>}
  </section>;
}
