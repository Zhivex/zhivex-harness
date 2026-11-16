import {AgentModel} from './AgentModel.js';
import {IntegrationSetup} from './IntegrationSetup.js';
import {Button} from './ui.js';
import {CalendarSetup} from './CalendarSetup.js';
import {TelegramSetup} from './TelegramSetup.js';
import {setupErrorMessage} from './setup-errors.js';
import { useEffect, useRef, useState } from 'react';
import { OPENAI_COMPATIBLE_PRESETS } from '@zhivex-ai/core';
import type { AssistantSetupState } from './bridge.js';

const providers = {
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
  qwen: { label: 'Qwen (Standard API)' },
  'qwen-cloud': { label: 'QwenCloud' },
  'qwen-token-plan': { label: 'QwenCloud Token Plan' },
  meta: { label: 'Meta / Muse' },
  mistral: { label: 'Mistral', baseURL: OPENAI_COMPATIBLE_PRESETS.mistral.baseURL },
  groq: { label: 'Groq', baseURL: OPENAI_COMPATIBLE_PRESETS.groq.baseURL },
  custom: { label: 'Custom endpoint' },
} as const;
type ProviderChoice = keyof typeof providers;

export function AssistantSetup({ onReady, onClose, returnToCode = false }: { onReady: () => Promise<void>; onClose: () => void; returnToCode?: boolean }) {
  const [state, setState] = useState<AssistantSetupState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const [name, setName] = useState('My assistant'), [baseURL, setBaseURL] = useState('');
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>('openai');
  const [model, setModel] = useState(''), [key, setKey] = useState(''), [apiMode, setApiMode] = useState('chat');
  const [local, setLocal] = useState(false), [daily, setDaily] = useState(false), [proactive, setProactive] = useState(false);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const [progress, setProgress] = useState('');
  useEffect(() => {if (error) errorElement.current?.focus();}, [error]);
  const [savedConnection, setSavedConnection] = useState('');
  const [showOptional, setShowOptional] = useState(false);
  const optionalVisible = Boolean(state?.editingExisting || showOptional || state?.calendar.pending || state?.telegram.pending);
  useEffect(() => {if (showOptional) document.getElementById("setup-optionals")?.focus();}, [showOptional]);
  useEffect(() => { let gone = false; void window.zhivex.setupState().then(next => { if (!gone) setState(next); }).catch(error => { if (!gone) setError(String(error.message)); }).finally(() => { if (!gone) setBusy(false); }); return () => { gone = true; }; }, []);
  async function act(action: string, value: unknown = {}) {
    if (busy) return false; setBusy(true); setError('');
    try { const next = await window.zhivex.setupAction(action, value); setState(next); await onReady(); if (['start', 'select'].includes(action)) onClose(); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'Configuration could not be saved.'); return false; }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!state?.calendar.pending || busy) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {const next = await window.zhivex.setupState(); if (!disposed) {setState(next); if (next?.calendar.pending) timer = setTimeout(() => void poll(), 500);}}
      catch {if (!disposed) setError('Could not read the authorization result. Reopen settings to inspect the connection.');}
    };
    void poll(); return () => {disposed = true; if (timer) clearTimeout(timer);};
  }, [state?.calendar.pending, busy]);
  useEffect(() => {if (state?.editing) {setDaily(state.tools.daily); setProactive(Boolean(state.tools.proactive));}}, [state?.editing]);
  async function configure() {
    if (busy) return; setBusy(true); setError('');
    const apiKey = key; setKey(''); setProgress('Checking model connection…');
    try {
      const selected = providers[providerChoice];
      const provider = providerChoice === 'meta'
        ? { kind: 'meta', model, apiKey }
        : providerChoice === 'qwen' || providerChoice === 'qwen-cloud' || providerChoice === 'qwen-token-plan'
          ? { kind: 'qwen', model, apiKey, region: 'singapore', service: providerChoice === 'qwen' ? 'model-studio' : providerChoice === 'qwen-cloud' ? 'qwencloud' : 'token-plan' }
          : { baseURL: 'baseURL' in selected ? selected.baseURL : baseURL, model, apiKey, apiMode: providerChoice === 'openai' || providerChoice === 'custom' ? apiMode : 'chat', allowInsecureLocalhost: providerChoice === 'custom' && local };
      let next = state?.editingExisting ? state : savedConnection ? await window.zhivex.setupAction('reuse-provider', {id: savedConnection}) : await window.zhivex.setupAction('provider', provider);
      setState(next); setProgress('Saving your configuration…'); next = await window.zhivex.setupAction('tools', {...state?.tools, daily, proactive}); setState(next);
      setProgress('Starting your assistant…');
      next = await window.zhivex.setupAction('start', {}); setState(next); await onReady(); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not connect to the model.'); }
    finally { setBusy(false); setProgress(''); }
  }
  return <section className="setup-panel panel" aria-label="Assistant settings">
    <div className="row"><h1>{state?.ready ? 'Your assistants' : 'Connect a model to get started'}</h1>{state?.ready || returnToCode ? <Button variant="secondary" onClick={onClose} disabled={busy}>{returnToCode ? 'Back to Code' : 'Back to chat'}</Button> : null}</div>
    <p>Your assistant starts with the app. Connections are kept in your system keychain, and conversations stay on this computer.</p>
    {error || state?.error ? <p ref={errorElement} tabIndex={-1} role="alert" className="notice">{setupErrorMessage(error || state?.error || '')}</p> : null}
    {state?.locked ? <p role="status">Your saved assistants are temporarily unavailable. Check any macOS keychain request, then retry startup to reload the saved state before making changes.</p> : null}
    {!state || state.locked || state.error ? <Button onClick={() => void act('retry')} disabled={busy}>Retry startup</Button> : null}
    {state?.profiles.length ? <div className="agent-list">{state.profiles.map(profile => <div className="row" key={profile.id}><div><strong>{profile.name}</strong><p>{profile.provider?.model}</p>{profile.active ? <Button variant="secondary" disabled={busy || state.editing} onClick={() => void act('edit-integrations', {id: profile.id})}>Edit integrations and tools</Button> : null}</div><Button variant="secondary" disabled={busy || state.locked || profile.active || state.editing} onClick={() => void act('select', { id: profile.id })}>{profile.active ? 'Active' : 'Use assistant'}</Button></div>)}</div> : null}
    {state?.editingExisting ? <p role="status">Save or discard your integration draft below before changing the model or web search.</p> : null}
    {state && !state.locked ? state.profiles.filter(profile => profile.active).map(profile => <AgentModel key={profile.id} profile={profile} connections={state.connections} busy={busy || state.editing} act={act}/>) : null}
    {state && !state.locked && !state.editing ? <form onSubmit={event => { event.preventDefault(); void act('begin', { name }); }}><label>Assistant name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} required /></label><Button type="submit" disabled={busy}>Create assistant</Button></form> : null}
    {state?.editing && !state.locked ? <form id="assistant-configuration" onSubmit={event => { event.preventDefault(); void configure(); }}>
      <p>{state.editingExisting ? `Update tools and connections for ${state.draftName}.` : 'Choose your provider and model to start chatting. Calendar, mail and other connections can wait.'}</p>
      {!state.editingExisting ? <>{state.connections.length ? <label>Saved model connection<select value={savedConnection} onChange={event => setSavedConnection(event.target.value)}><option value="">New connection</option>{state.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {connection.model}</option>)}</select></label> : null}{!savedConnection ? <>
      <label htmlFor="assistant-provider">Provider</label><select id="assistant-provider" value={providerChoice} onChange={event => setProviderChoice(event.target.value as ProviderChoice)}>{Object.entries(providers).map(([id, provider]) => <option key={id} value={id}>{provider.label}</option>)}</select>
      {providerChoice === 'custom' ? <label>API URL<input type="url" value={baseURL} onChange={event => setBaseURL(event.target.value)} required placeholder="https://provider.example/v1" /></label> : null}
      <label>Model<input aria-describedby="model-help" value={model} placeholder="Model ID from your provider" onChange={event => setModel(event.target.value)} required /></label>
      <small id="model-help">Use the model ID shown in your provider’s account.</small>
      <label>API key<input type="password" value={key} autoComplete="off" onChange={event => setKey(event.target.value)} required /></label>
      {providerChoice === 'openai' || providerChoice === 'custom' ? <details className="setup-advanced"><summary>Advanced connection options</summary><label>API format<select value={apiMode} onChange={event => setApiMode(event.target.value)}><option value="chat">Chat completions</option><option value="responses">Responses</option></select></label></details> : null}
      {providerChoice === 'custom' ? <label className="row"><input type="checkbox" checked={local} onChange={event => setLocal(event.target.checked)} />Allow HTTP for a local model on this computer</label> : null}
      </> : null}</> : <p>The current agent is paused while you update integrations. Conversations and notes are preserved. Save to restart, or discard to restore its previous configuration.</p>}
      {optionalVisible ? <><label className="row"><input type="checkbox" checked={daily} onChange={event => setDaily(event.target.checked)} />Enable tasks and reminders</label>
      <label className="row"><input type="checkbox" checked={proactive} onChange={event => {setProactive(event.target.checked); if (event.target.checked) setDaily(true);}} />Enable reviewed proactive alerts</label></> : null}
    </form> : null}
    {state?.editing && !state.locked ? <>
      {optionalVisible ? <section id="setup-optionals" tabIndex={-1} className="optional-integrations" aria-labelledby="integrations-heading">
        <h2 id="integrations-heading">Connections</h2>
        <p>You can skip these and add them later in Assistant settings. Each connection button starts its own authorization; complete it before starting the assistant.</p>
        <CalendarSetup state={state.calendar} busy={busy} act={act} />
        <IntegrationSetup state={state} busy={busy} act={act} />
        <TelegramSetup key={state.draftName} state={state.telegram} busy={busy} act={act} />
      </section> : null}
      <footer id="setup-completion" tabIndex={-1} className="setup-actions">
        <p>{state.editingExisting ? 'Save your configuration and restart the assistant.' : 'Ready to chat. Add optional connections later in Assistant settings.'}</p>
        <div className="row"><Button type="submit" form="assistant-configuration" disabled={busy || state.telegram.pending || state.calendar.pending}>{busy ? progress || 'Preparing…' : state.editingExisting ? 'Save configuration and restart' : 'Connect and start'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => void act('discard')}>Discard draft</Button></div>
      </footer>
      {!optionalVisible ? <Button variant="ghost" aria-expanded={false} aria-controls="setup-optionals" onClick={() => setShowOptional(true)}>Configure optional connections now</Button> : null}
    </> : null}
    {busy ? <p role="status">{progress || 'Preparing your assistant…'}</p> : null}
  </section>;
}
