import {useState} from 'react';
import type {AssistantSetupState} from './bridge.js';

export function TelegramSetup({state, busy, act}: {state: AssistantSetupState['telegram']; busy: boolean; act(action: string, value?: unknown): Promise<unknown>}) {
  const [token, setToken] = useState(''), [reviewedUser, setReviewedUser] = useState(''), [error, setError] = useState('');
  async function connect() {const value = token; setToken(''); setReviewedUser(''); await act('telegram', {token: value});}
  async function open() {setError(''); try {await window.zhivex.openTelegram();} catch {setError('Could not open the pairing link. Refresh the setup or begin pairing again.');}}
  return <section aria-label="Telegram connection" className="telegram-setup connection-section">
    <h3>Telegram (optional)</h3><p>Link a private Telegram account to this assistant for conversations and scheduled summaries. Enabling a summary requires a separate confirmation.</p>
    {error ? <p role="alert">{error}</p> : null}
    {state.configured ? <div><p role="status">Telegram is linked in this draft. It will start with the assistant.</p><button type="button" className="secondary" disabled={busy} onClick={() => void act('telegram-remove')}>Remove Telegram from draft</button><p>Removing it here does not revoke the bot token at Telegram.</p></div> : null}
    {!state.pending && !state.configured ? <form onSubmit={event => {event.preventDefault(); void connect();}}>
      <label>Telegram bot token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} disabled={busy} required /></label>
      <p>Use a bot token from BotFather. It is saved with the connection in your system keychain after you confirm the account.</p>
      <button className="secondary" disabled={busy || !token.trim()}>Verify Telegram bot</button>
    </form> : null}
    {state.pending ? <div>
      <p>Open the pairing link and press Start in your private chat with the bot. The link expires after ten minutes.</p>
      <div className="row"><button type="button" disabled={busy || !state.url} onClick={() => void open()}>Open Telegram pairing</button><button type="button" className="secondary" disabled={busy} onClick={() => void act('telegram-check')}>Check private account</button><button type="button" className="secondary" disabled={busy} onClick={() => void act('telegram-cancel')}>Cancel Telegram pairing</button></div>
      {state.candidate ? <div><p>Detected Telegram user ID: <strong>{state.candidate}</strong>. Confirm only if this is your account.</p>
        <label className="automation-confirmation"><input type="checkbox" checked={reviewedUser === state.candidate} onChange={event => setReviewedUser(event.target.checked ? state.candidate! : '')} disabled={busy} />This is my private Telegram account</label>
        <button type="button" disabled={busy || reviewedUser !== state.candidate} onClick={() => void act('telegram-confirm', {userId: state.candidate})}>Confirm Telegram account</button>
      </div> : <p>No verified private account yet.</p>}
    </div> : null}
  </section>;
}
