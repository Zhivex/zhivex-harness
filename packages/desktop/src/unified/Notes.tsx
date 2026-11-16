import {useEffect, useState} from 'react';
import type {NotesSnapshot} from '@zhivex-ai/harness/application/protocol';

export function Notes({projectId, disabled, onAsk, onSettings}: {
  projectId: string; disabled: boolean; onAsk(prompt: string): Promise<void>; onSettings(): void;
}) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0), [noteId, setNoteId] = useState<string>();
  const [refresh, setRefresh] = useState(0), [snapshot, setSnapshot] = useState<NotesSnapshot>();
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [title, setTitle] = useState(''), [text, setText] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let disposed = false; setLoading(true); setSnapshot(undefined); setError('');
    void window.zhivex.notes(projectId, {query: search, offset, ...(noteId ? {noteId} : {})}).then(value => {
      if (!disposed) setSnapshot(value);
    }).catch(() => {
      if (!disposed) setError('Could not read these notes. Refresh the list; the selected note may have been removed. Unavailable data does not mean there are no notes.');
    }).finally(() => {if (!disposed) setLoading(false);});
    return () => {disposed = true;};
  }, [projectId, search, offset, noteId, refresh]);
  const ask = (tool: string, input: unknown) => onAsk(`Use ${tool} with exactly this input: ${JSON.stringify(input)}. Request approval before changing data. Do not perform other actions. Report the actual result.`);
  const locked = disabled || loading || !snapshot?.enabled;
  return <section className="panel code-tools personal-tools" aria-label="Personal notes">
    <h2>Notes</h2><p>Private notes saved by this assistant. Saving or deleting a note requires review in your conversation.</p>
    <form onSubmit={event => {event.preventDefault(); setOffset(0); setNoteId(undefined); setSearch(query.trim()); setRefresh(value => value + 1);}}>
      <label>Search notes<input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label>
      <button disabled={loading}>Search notes</button>
    </form>
    <button className="secondary" disabled={loading} onClick={() => {setNoteId(undefined); setRefresh(value => value + 1);}}>Refresh notes</button>
    {loading ? <p role="status">Reading notes…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {snapshot && !snapshot.enabled ? <div><p>Notes require tasks and reminders to be enabled for this assistant.</p><button onClick={onSettings}>Configure notes</button></div> : null}
    {snapshot?.enabled ? <>
      <h3>Saved notes ({snapshot.total})</h3>
      {snapshot.notes.length ? <ul className="personal-list">{snapshot.notes.map(note => <li key={note.id}><div><strong>{note.title}</strong><p>{new Date(note.created_at).toLocaleString()}</p></div><button className="secondary" onClick={() => setNoteId(note.id)}>Read note</button></li>)}</ul> : <p>{search ? 'No notes match this search.' : 'No saved notes on this page.'}</p>}
      <div className="row"><button className="secondary" disabled={loading || offset === 0} onClick={() => {setNoteId(undefined); setOffset(value => Math.max(0, value - 20));}}>Previous notes</button><button className="secondary" disabled={loading || snapshot.nextOffset === null} onClick={() => {setNoteId(undefined); setOffset(snapshot.nextOffset!);}}>More notes</button></div>
      {snapshot.note ? <section aria-label="Selected note"><h3>{snapshot.note.title}</h3><p style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>{snapshot.note.body}</p><button className="secondary" disabled={locked} onClick={() => void ask('daily_write_delete_note', {requestId: crypto.randomUUID(), noteId: snapshot.note!.id})}>Ask to delete note</button></section> : null}
      <form onSubmit={event => {event.preventDefault(); void ask('daily_write_save_note', {requestId, title: title.trim(), text});}}>
        <h3>New note</h3><label>Note title<input required maxLength={500} value={title} onChange={event => {setTitle(event.target.value); setRequestId(crypto.randomUUID());}} /></label>
        <label>Note text<textarea required maxLength={16000} value={text} onChange={event => {setText(event.target.value); setRequestId(crypto.randomUUID());}} /></label>
        <button disabled={locked || !title.trim() || !text.trim()}>Ask to save note</button>
      </form>
    </> : null}
  </section>;
}
