import {useEffect, useState} from 'react';
import {readPreference, writePreference} from '../local-preferences.js';

export function MailDrafts({projectId, disabled, onAsk, onSettings}: {projectId: string; disabled: boolean; onAsk(prompt: string): Promise<void>; onSettings(): void}) {
  const [tools, setTools] = useState<string[]>(), [error, setError] = useState('');
  const [draft, setDraft] = useState(() => {
    try {const value = JSON.parse(readPreference('draft', projectId, 'mail-form')); if (typeof value.requestId === 'string' && ['to','subject','body','source'].every(key => typeof value[key] === 'string')) return value as {requestId: string; to: string; subject: string; body: string; source: string};} catch {}
    return {requestId: crypto.randomUUID(), to: '', subject: '', body: '', source: 'google'};
  });
  useEffect(() => {let disposed = false; void window.zhivex.catalog().then(catalog => {if (!disposed) setTools(catalog?.runtimes.find(runtime => runtime.projectId === projectId)?.binding.tools ?? []);}).catch(() => {if (!disposed) setError('Connection capabilities are unavailable. Reopen this page before preparing a draft.');}); return () => {disposed = true;};}, [projectId]);
  const change = (patch: Partial<typeof draft>) => {const next = {...draft, ...patch, requestId: crypto.randomUUID()}; setDraft(next); if (!writePreference('draft', projectId, 'mail-form', JSON.stringify(next))) setError('This local draft could not be saved.');};
  const tool = draft.source === 'google' ? 'google_write_mail_apply_draft' : 'microsoft_write_apply';
  const [preparing, setPreparing] = useState(false);
  const ask = async () => {
    if (preparing || disabled) return; setPreparing(true); setError('');
    try {
      const reference = await window.zhivex.prepareMailDraft(projectId, draft.source as 'google' | 'microsoft', {requestId: draft.requestId, to: draft.to.split(',').map(value => value.trim()), subject: draft.subject, body: draft.body});
      await onAsk(`Use ${tool} with exactly this input: ${JSON.stringify(reference)}. Request approval of the exact stored draft. Never send mail. Never retry an uncertain operation using a new requestId. Report the actual result.`);
    } catch {setError('Could not confirm this draft proposal. Reopen the saved operation before retrying.');}
    finally {setPreparing(false);}
  };
  return <section className="panel code-tools personal-tools" aria-label="Mail drafts"><h2>Mail drafts</h2><p>Prepare a new message for review. Approval creates a provider draft only; this app does not send it. Replies should be prepared from the exact thread in your conversation.</p>
    {error ? <p role="alert">{error}</p> : tools === undefined ? <p role="status">Reading mail capabilities…</p> : null}
    <form onSubmit={event => {event.preventDefault(); void ask();}}>
      <label>Draft provider<select value={draft.source} onChange={event => change({source: event.target.value})}><option value="google">Gmail</option><option value="microsoft">Outlook</option></select></label>
      <label>Recipients (comma separated)<input required value={draft.to} onChange={event => change({to: event.target.value})}/></label>
      <label>Draft subject<input required maxLength={500} value={draft.subject} onChange={event => change({subject: event.target.value})}/></label>
      <label>Draft body<textarea maxLength={16000} value={draft.body} onChange={event => change({body: event.target.value})}/></label>
      <button disabled={disabled || preparing || !tools?.includes(tool)}>Review draft creation</button>
    </form>
    {tools && !tools.includes(tool) ? <><p>This assistant has no draft capability for the selected provider.</p><button onClick={onSettings}>Manage mail connections</button></> : null}
    <p>After an uncertain response, inspect its receipt in the conversation before creating another draft.</p>
    <button disabled={disabled || preparing || !tools?.includes(tool)} onClick={() => void onAsk(`Read ${draft.source === 'google' ? 'google_read_mail_draft_status' : 'microsoft_read_operation_status'} with requestId ${draft.requestId}. Inspect only; do not create or send mail.`)}>Inspect saved draft operation</button>
  </section>;
}
