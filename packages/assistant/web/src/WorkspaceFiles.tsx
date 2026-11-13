import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AssistantFileList, AssistantFileView } from '../../src/application-contracts.js';

export function WorkspaceFiles({ projectKey, target, attach }: {
  projectKey: string; target: { path: string; line: number } | null; attach(file: AssistantFileView): void;
}) {
  const [list, setList] = useState<AssistantFileList>({ files: [], truncated: false });
  const [view, setView] = useState<AssistantFileView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const controller = useRef<AbortController | null>(null);
  const listController = useRef<AbortController | null>(null);
  const read = async (path: string, line = 1) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setLoading(true); setError(''); setView(null);
    try { const file = await api<AssistantFileView>(`workspace/file?${new URLSearchParams({ projectKey, path, startLine: String(line) })}`, undefined, { signal: request.signal }); if (!request.signal.aborted) setView(file); }
    catch (error) { if (!request.signal.aborted) setError((error as Error).message); }
    finally { if (!request.signal.aborted) setLoading(false); }
  };
  const load = async (cursor?: string) => {
    listController.current?.abort(); const request = new AbortController(); listController.current = request;
    try {
      const page = await api<AssistantFileList>(`workspace/files?${new URLSearchParams({ projectKey, ...(cursor ? { cursor } : {}) })}`, undefined, { signal: request.signal });
      if (!request.signal.aborted) setList(previous => ({ ...page, files: cursor ? [...previous.files, ...page.files] : page.files }));
    } catch (error) { if (!request.signal.aborted) setError((error as Error).message); }
  };
  useEffect(() => { void load(); return () => { controller.current?.abort(); listController.current?.abort(); }; }, [projectKey]);
  useEffect(() => { if (target) void read(target.path, target.line); }, [target]);
  return <aside className="workspace-files" aria-label="Archivos del proyecto">
    <div className="workspace-pane-title"><h3>Archivos</h3><button onClick={() => { setError(''); void load(); }}>Actualizar</button></div>
    <label className="workspace-filter">Buscar en la lista<input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Nombre del archivo"/></label>
    <nav className="workspace-file-list" aria-label="Lista de archivos">{list.files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())).map(file => <button className={view?.path === file.path ? 'selected' : ''} key={file.path} onClick={() => void read(file.path)}>{file.path}</button>)}{list.nextCursor && list.files.length < 1000 ? <button onClick={() => void load(list.nextCursor)}>Cargar más archivos</button> : null}</nav>
    {error ? <p className="workspace-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">Abriendo archivo…</p> : null}
    {view ? <section className="workspace-file-view" aria-label={view.path}>
      <div className="workspace-file-heading"><strong>{view.path}</strong><button disabled={view.clippedLine} onClick={() => attach(view)}>Adjuntar estas líneas</button></div>
      <p className="workspace-file-range">Líneas {view.startLine}–{view.endLine} de {view.totalLines}{view.clippedLine ? ' · línea recortada' : ''}</p>
      <pre tabIndex={0}>{view.content}</pre>
      <div className="workspace-file-pagination"><button disabled={view.startLine <= 1} onClick={() => void read(view.path, Math.max(1, view.startLine - 120))}>Anteriores</button><button disabled={view.endLine >= view.totalLines || view.clippedLine} onClick={() => void read(view.path, view.endLine + 1)}>Siguientes</button></div>
    </section> : !loading ? <p className="workspace-empty">Elegí un archivo para inspeccionarlo y añadir contexto a la conversación.</p> : null}
  </aside>;
}
