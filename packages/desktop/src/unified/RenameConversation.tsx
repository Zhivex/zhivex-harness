import {useRef, useState} from 'react';
import type {HarnessClientSession} from '@zhivex-ai/harness/protocol';
import {Button, ShellDialog} from './ui.js';

export function RenameConversation({hostId, session, onClose, onSaved}: {
  hostId: string; session: HarnessClientSession; onClose(): void; onSaved(): void;
}) {
  const [title, setTitle] = useState(session.title ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const close = () => {if (!lock.current) onClose();};
  return <ShellDialog labelledBy="rename-title" className="rename-conversation" onClose={close} initialFocus="input">
    <h2 id="rename-title">Rename conversation</h2>
    <form onSubmit={event => {
      event.preventDefault(); if (lock.current || error || !title.trim()) return;
      lock.current = true; setBusy(true);
      void window.zhivex.command(hostId, {method: 'session.rename', sessionId: session.sessionId,
        expectedRevision: session.revision, idempotencyKey: crypto.randomUUID(), title: title.trim()}).then(result => {
        if (!result.ok || result.data.kind !== 'session' || result.data.session.sessionId !== session.sessionId) throw new Error();
        onSaved();
      }).catch(() => setError('The new title could not be confirmed. Close this dialog and refresh the conversation before trying again.'))
        .finally(() => {lock.current = false; setBusy(false);});
    }}>
      <label htmlFor="conversation-title">Conversation title</label>
      <input id="conversation-title" maxLength={256} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
      <div className="row"><Button variant="secondary" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || Boolean(error) || !title.trim()}>{busy ? 'Saving…' : 'Save title'}</Button></div>
    </form>
  </ShellDialog>;
}
