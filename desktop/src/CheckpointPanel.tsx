import { useEffect, useRef, useState } from 'react';
import type { HarnessClientData, HarnessClientSession } from '@zhivex-ai/harness/protocol';
import type { CheckpointReview } from './checkpoint-review.js';
import { FileDiff } from './FileDiff.js';

export function CheckpointPanel({ projectKey, session, disabled, onOpen }: {
  projectKey: string; session: HarnessClientSession; disabled: boolean; onOpen: (sessionId: string) => Promise<void>;
}) {
  const [listing, setListing] = useState<Extract<HarnessClientData, { kind: 'checkpoints' }>>();
  const [review, setReview] = useState<CheckpointReview>();
  const [paths, setPaths] = useState(''), [turnId, setTurnId] = useState(session.runs.at(-1)?.turnId ?? '');
  const [childId, setChildId] = useState(''), [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const terminalTurns = session.runs.filter(run => ['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status));
  const selectedTurn = terminalTurns.some(run => run.turnId === turnId) ? turnId : terminalTurns.at(-1)?.turnId ?? '';
  const mounted = useRef(true), pending = useRef(false);
  const reviewElement = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (review) { reviewElement.current?.scrollIntoView({ block: 'start' }); reviewElement.current?.focus({ preventScroll: true }); } }, [review?.ticketId]);
  const command = async (value: Record<string, unknown>) => {
    const result = await window.harness.command(projectKey, { ...value, sessionId: session.sessionId });
    if (!result.ok) throw new Error(result.error.code); return result.data;
  };
  const load = async () => {
    const result = await command({ method: 'checkpoint.list' });
    if (result.kind !== 'checkpoints') throw new Error();
    if (mounted.current) setListing(result);
  };
  const act = async (action: () => Promise<void>) => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError('');
    try { await action(); } catch { if (mounted.current) setError('Could not complete this action. Reload saved operations before retrying; a lost response does not mean no change occurred.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const showReview = (value: CheckpointReview) => { if (mounted.current) { setReview(value); setAccepted(false); } };
  return <section className="decision-history checkpoint-panel" aria-label="Workspace checkpoints" data-action="checkpoints">
    <button type="button" className="secondary" disabled={busy || disabled} onClick={() => void act(load)}>Workspace checkpoints</button>
    {error ? <p role="alert">{error}</p> : null}
    {listing ? <fieldset disabled={busy || disabled}><legend>Selected text files</legend>
      <p>Up to 20 existing UTF-8 files, 64 KiB each. No creation, deletion, binary files or permission rollback. This is not a full workspace snapshot.</p>
      <details><summary>Capture current files</summary><p>Captures current contents for the selected completed turn, not historical versions.</p>
        <label>Conversation turn<select value={selectedTurn} onChange={event => setTurnId(event.target.value)}>{terminalTurns.map(run => <option key={run.turnId} value={run.turnId}>{run.turnId} · {run.status}</option>)}</select></label>
        <label>Relative paths, one per line<textarea value={paths} onChange={event => setPaths(event.target.value)} /></label>
        <button type="button" disabled={!paths.trim() || !selectedTurn} onClick={() => void act(async () => {
          await command({ method: 'checkpoint.capture', turnId: selectedTurn, paths: paths.split('\n').map(value => value.trim()).filter(Boolean), expectedRevision: session.revision, idempotencyKey: crypto.randomUUID() }); await load();
        })}>Capture selected files</button>
      </details>
      {listing.checkpoints.length === 0 ? <p>No captured checkpoints in this conversation.</p> : null}
      {listing.checkpoints.map(checkpoint => <article key={checkpoint.id}><h4>{checkpoint.turnId}</h4><p>{checkpoint.files.map(file => file.path).join(', ')}</p>
        <button type="button" onClick={() => void act(async () => {
          const inspected = await command({ method: 'checkpoint.inspect', checkpointId: checkpoint.id });
          if (inspected.kind !== 'checkpoint' || inspected.inspection.files.some(file => file.status !== 'available')) {
            setError(inspected.kind === 'checkpoint' ? 'Files cannot be restored: ' + inspected.inspection.files.filter(file => file.status !== 'available').map(file => `${file.path} (${file.status})`).join(', ') : 'Could not inspect checkpoint files.'); return;
          }
          const expected = Object.fromEntries(inspected.inspection.files.map(file => [file.path, file.status === 'available' ? file.expectedDigest : '']));
          const prepared = await command({ method: 'restore.prepare', checkpointId: checkpoint.id, expected, expectedRevision: session.revision, idempotencyKey: crypto.randomUUID() });
          if (prepared.kind !== 'restore') throw new Error(); await load();
          showReview(await window.harness.reviewCheckpoint(projectKey, session.sessionId, prepared.operation.id));
        })}>Prepare restore review</button></article>)}
      <h4>Saved restore operations</h4>
      {listing.restores.map(operation => <article key={operation.id}><p>{operation.id} · {operation.stage}</p>
        {operation.stage === 'completed' && operation.forkSessionId ? <button type="button" onClick={() => void act(() => onOpen(operation.forkSessionId!))}>Open restored conversation</button>
          : operation.stage === 'forking' ? <><p>Conversation creation was interrupted. Select the existing child titled restore:{operation.id}; recovery does not write files.</p>
            <label>Existing child session ID<input value={childId} onChange={event => setChildId(event.target.value)} /></label>
            <button type="button" disabled={!childId.trim()} onClick={() => void act(async () => showReview(await window.harness.reviewCheckpointRecovery(projectKey, session.sessionId, operation.id, childId.trim())))}>Review recovery</button></>
          : <button type="button" onClick={() => void act(async () => showReview(await window.harness.reviewCheckpoint(projectKey, session.sessionId, operation.id)))}>Review saved operation</button>}
      </article>)}
      {review ? <section ref={reviewElement} tabIndex={-1} aria-label="Review checkpoint restoration"><h4>{review.recoverySessionId ? 'Recover existing conversation' : review.completionOnly ? 'Confirm restored state' : 'Review file restoration'}</h4>
        <p>The original conversation is preserved. Restoring opens a derived conversation.</p>
        {review.recoverySessionId ? <p>Use existing child {review.recoverySessionId}. No files will be changed by this recovery step.</p> : null}
        {review.completionOnly ? <p>All captured files already match the checkpoint. Confirm the interrupted operation as completed; the engine rechecks the files.</p> : null}
        {review.preview.status === 'available' ? review.preview.diff.files.map(file => <section key={file.path}><h5>{file.path}</h5><FileDiff before={file.before ?? undefined} after={file.after ?? undefined} /></section>)
          : !review.recoverySessionId && !review.completionOnly ? <p>Exact diff unavailable. Reload the operation and resolve conflicting or partial changes before continuing.</p> : null}
        {review.redacted ? <p>Some content is hidden. Approval is disabled because the full change cannot be reviewed here.</p> : null}
        <label><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />I reviewed this operation and its effects.</label>
        <button type="button" disabled={!review.canApply || !accepted} onClick={() => void act(async () => {
          const ticket = review.ticketId; setReview(undefined); setAccepted(false);
          const result = await window.harness.resolveCheckpointReview(projectKey, ticket, true);
          if (!result?.ok || result.data.kind !== 'restore') throw new Error();
          if (!mounted.current) return;
          if (result.data.session) await onOpen(result.data.session.sessionId); else await load();
        })}>Confirm {review.recoverySessionId ? 'recovery' : 'restoration'}</button>
        <button type="button" onClick={() => void act(async () => { await window.harness.resolveCheckpointReview(projectKey, review.ticketId, false); setReview(undefined); setAccepted(false); })}>Cancel review</button>
      </section> : null}
    </fieldset> : null}
  </section>;
}
