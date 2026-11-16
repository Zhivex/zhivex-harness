import type {Ref} from 'react';
import {ArrowUp, ShieldCheck, Square} from 'lucide-react';
import {Button} from './ui.js';

export function MessageEditor({inputRef, value, placeholder, disabled, sendDisabled, sending = false, running, cancelling, waiting, stored, onChange, onSend, onCancel}: {
  inputRef: Ref<HTMLTextAreaElement>; value: string; placeholder: string; disabled: boolean; sendDisabled: boolean;
  sending?: boolean; running: boolean; cancelling: boolean; waiting: boolean; stored: boolean;
  onChange(value: string): void; onSend(): void; onCancel(): void;
}) {
  return <form className="composer" onSubmit={event => {event.preventDefault(); if (!sendDisabled) onSend();}}>
    <label className="sr-only" htmlFor="prompt">Message</label>
    <textarea id="prompt" ref={inputRef} value={value} disabled={disabled} placeholder={placeholder} onChange={event => onChange(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); if (!sendDisabled) onSend();}
    }}/>
    <div className="composer-footer"><span className="muted"><ShieldCheck size={14}/>{waiting ? 'Waiting for your review' : running ? 'Zhivex is responding…' : sending ? 'Sending your message…' : 'Actions stay within your permissions'}</span>
      {running ? <Button variant="secondary" onClick={onCancel} disabled={cancelling} aria-label="Cancel task"><Square size={16}/>Cancel</Button>
        : <Button type="submit" aria-label="Send message" disabled={sendDisabled}><ArrowUp size={18}/>{sending ? 'Sending…' : 'Send'}</Button>}
    </div>
    <p className="composer-hint">Enter to send · Shift + Enter for a new line{!stored ? ' · Draft could not be saved to disk' : ''}</p>
  </form>;
}
