import {useRef, useState} from 'react';
import type {AssistantSetupState} from './bridge.js';

export function AgentModel({profile, connections, busy, act}: {profile: AssistantSetupState['profiles'][number]; connections: AssistantSetupState['connections']; busy: boolean; act(action: string, input: unknown): Promise<boolean>}) {
  const [name, setName] = useState(profile.name), [model, setModel] = useState(profile.provider?.model ?? '');
  const [connectionId, setConnectionId] = useState(profile.connectionId ?? connections[0]?.id ?? '');
  const [webSearch, setWebSearch] = useState(profile.provider?.webSearch ?? false);
  const [saved, setSaved] = useState('');
  const lock = useRef(false);
  const supported = Boolean(connections.find(connection => connection.id === connectionId)?.canEnableWebSearch);
  return <form aria-label="Agent model" onSubmit={async event => {event.preventDefault(); if (busy || lock.current) return; lock.current = true; setSaved(''); try {if (await act('agent-update', {id: profile.id, name, model, connectionId, webSearch: supported && webSearch})) setSaved('Assistant settings saved. Your conversations are preserved.');} finally {lock.current = false;}}}>
    <h3>Active agent and model</h3><p>Changes require an idle agent and restart its runtime. Saved conversations remain in this agent.</p>
    <label>Agent display name<input disabled={busy} required maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label>
    <label>Agent model connection<select value={connectionId} disabled={busy} onChange={event => {setConnectionId(event.target.value); setSaved(''); if (!connections.find(connection => connection.id === event.target.value)?.canEnableWebSearch) setWebSearch(false);}}>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
    <label>Agent model ID<input disabled={busy} required maxLength={200} value={model} onChange={event => setModel(event.target.value)}/></label>
    <label className="row web-search-option"><input type="checkbox" checked={supported && webSearch} disabled={busy || !supported} aria-describedby="web-search-help" onChange={event => {setWebSearch(event.target.checked); setSaved('');}} />Search the internet</label>
    <p id="web-search-help">{supported ? 'Allow this assistant to search the web for current information and cite sources. Uses OpenAI Responses; searches may incur provider charges. Your existing chats stay with this assistant.' : 'Web search requires a connection to the official OpenAI API. Select a compatible connection to enable it.'}</p>
    <p className="muted">The change takes effect after saving. Finish running tasks and pending reviews first.</p>
    {saved ? <p role="status">{saved}</p> : null}
    <button disabled={busy || !connectionId}>Save agent and model</button>
  </form>;
}
