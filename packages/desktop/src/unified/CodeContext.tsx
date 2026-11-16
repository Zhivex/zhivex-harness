import {useEffect, useState} from 'react';
import type {CodeContextSnapshot} from '@zhivex-ai/harness/application/protocol';

export function CodeContext({projectId}: {projectId: string}) {
  const [snapshot, setSnapshot] = useState<CodeContextSnapshot>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(''); setSnapshot(undefined);
    void window.zhivex.codeContext(projectId).then(value => {if (!disposed) setSnapshot(value);})
      .catch(() => {if (!disposed) setError('Could not read the active project context. Reconnect or retry.');})
      .finally(() => {if (!disposed) setLoading(false);});
    return () => {disposed = true;};
  }, [projectId, refresh]);
  return <section className="panel code-tools" aria-label="Code context"><h2>Project context</h2>
    <p>Rules and context loaded by this project’s host. Refresh reads that loaded configuration; it does not reload files changed on disk.</p>
    <button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh context</button>
    {loading ? <p role="status">Reading project context…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {snapshot ? <>
      <h3>Configured model</h3><p>{snapshot.provider} / {snapshot.model}</p>
      <p>Earlier turns retain their recorded model. This view does not change the model or permissions.</p>
      <h3>Loaded project instructions</h3><p>Project context: {snapshot.enabled ? 'enabled' : 'disabled'}</p>
      <p>Bundle fingerprint</p><pre>{snapshot.fingerprint}</pre>
      {snapshot.manifest ? <article><h4>Context manifest</h4><p>{snapshot.manifest.path} · {snapshot.manifest.bytes} bytes</p><pre>{snapshot.manifest.digest}</pre></article> : null}
      {snapshot.sources.length ? snapshot.sources.map((source, index) => <article key={index}><h4>{source.path}</h4><p>{source.kind} · {source.bytes} bytes</p><pre>{source.digest}</pre></article>) : <p>No project rules or context files loaded.</p>}
      <h3>Available skills</h3><p>Skills are loaded on demand. Being listed here does not mean a skill was used in this conversation.</p>
      {snapshot.skills.length ? snapshot.skills.map((skill, index) => <article key={index}><h4>{skill.id}</h4><p>{skill.path} · {skill.bytes} bytes</p><pre>{skill.digest}</pre></article>) : <p>No project skills indexed.</p>}
    </> : null}
  </section>;
}
