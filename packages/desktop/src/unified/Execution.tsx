import { useEffect, useState } from 'react';
import type { HarnessClientRun } from '@zhivex-ai/harness/protocol';

export function Execution({ disabled, cancelling, run, onRun, onReview, onCancel, onConversation }: { disabled: boolean; cancelling: boolean; run?: HarnessClientRun | undefined; onRun(prompt: string): Promise<void>; onReview(): void; onCancel(): void; onConversation(): void }) {
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof window.zhivex.checks>>>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  useEffect(() => { setLoading(true); setError(''); setChecks([]); let gone = false; void window.zhivex.checks().then(value => { if (!gone) setChecks(value); }).catch(() => { if (!gone) setError('Could not read allowed checks. The project needs a readable package.json with configured scripts.'); }).finally(() => { if (!gone) setLoading(false); }); return () => { gone = true; }; }, [refresh]);
  const results = run?.decisions?.filter(decision => decision.name === 'run_check') ?? [];
  return <section className="panel code-tools" aria-label="Code execution"><h2>Run project checks</h2><p>Ask Code to run a declared check. Review the exact command before execution. Checks run on this computer and require the project’s tools to be installed.</p>
    {error ? <p role="alert">{error}</p> : null}
    <button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Reload checks</button>
    {loading ? <p role="status">Loading project checks…</p> : null}
    {!loading && checks.length === 0 && !error ? <p>No allowed package checks found.</p> : null}
    {checks.map(check => <article key={check.name}><h3>{check.name}</h3><pre>{check.argv.join(' ')}</pre><pre>{check.script}</pre><button disabled={disabled} onClick={() => void onRun(`Run the project check ${JSON.stringify(check.name)} using run_check with expectedScript ${JSON.stringify(check.script)}. Read package.json first. Request approval of the exact script; do not edit files or substitute another command. Report the actual exit code and output.`)}>Ask Code to run {check.name}</button></article>)}
    <h3>Current task</h3><p role="status">{run?.status.replaceAll('_', ' ') ?? 'Create a conversation to begin.'}</p>
    {run?.status === 'waiting_approval' ? <button onClick={onReview}>Review execution</button> : null}
    {run && ['created', 'running', 'queued', 'cancel_requested'].includes(run.status) ? <button className="secondary" disabled={cancelling || run.status === 'cancel_requested'} onClick={onCancel}>{cancelling || run.status === 'cancel_requested' ? 'Cancellation requested…' : 'Cancel execution'}</button> : null}
    {run ? <section aria-label="Recorded check results"><h3>Recorded check results</h3>
      {results.length ? results.map(result => <article key={result.approvalId}>
        <h4>run_check</h4>
        <p>{result.status === 'rejected' ? 'Rejected; execution was not authorized.' : result.evidence?.exitCode !== undefined ? `Exit code: ${result.evidence.exitCode}${result.evidence.timedOut ? ' · Timed out' : ''}` : result.status === 'failed' ? 'Execution failed without an exit code.' : 'No confirmed execution result yet.'}</p>
        {result.evidence?.exitCode !== undefined ? <p>{result.status === 'succeeded' ? 'Check passed.' : 'Check did not pass.'}</p> : null}
      </article>) : <p>No reviewed check result recorded on this page.</p>}
      {run.decisionNextOffset !== undefined ? <p>More decisions are available in Decision history.</p> : null}
      <p>A completed conversation alone does not confirm that a check passed.</p>
    </section> : null}
    <button className="secondary" onClick={onConversation}>View output and conversation</button>
    <p>Results and command output are recorded in the conversation. A failed or cancelled task is not reported as a successful check.</p>
  </section>;
}
