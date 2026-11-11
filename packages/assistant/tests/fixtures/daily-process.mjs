import { appendFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startAssistantHost, createTelegramBridge } from '../../dist/index.js';
const [directory, mode] = process.argv.slice(2);
let now = Date.parse('2026-11-10T09:00:00Z'), sends = 0;
const api = { async call(method, payload) {
  if (method === 'getMe') return { id: 999, is_bot: true };
  if (method === 'getWebhookInfo') return { url: '' };
  if (method === 'sendMessage') { await appendFile(directory + '/sends.jsonl', JSON.stringify(payload) + '\n'); return { message_id: ++sends, chat: { id: 123 } }; }
  return true;
} };
const host = await startAssistantHost({ directory, ownerId: 'owner', recover: mode === 'recover', engine: { modelInstance: createMockLanguageModel() } });
const bridge = await createTelegramBridge({ stateDirectory: directory + '/state', credentialsPath: host.credentialsPath, ownerId: 'owner',
  expectedTelegramUserId: '123', api, now: () => now, recover: mode === 'recover', agendaSource: {
    binding: 'account1:primary', calendarId: 'primary', async list() {
      await appendFile(directory + '/reads.jsonl', 'read\n');
      if (mode === 'hang') { console.log(JSON.stringify({ kind: 'reading' })); await new Promise(() => {}); }
      return { events: [], nextPageToken: null, complete: true };
    }
  } });
const message = (id, text) => ({ update_id: id, message: { message_id: id, from: { id: 123 }, chat: { id: 123, type: 'private' }, text } });
if (mode === 'hang') {
  bridge.ingest([message(1, `/start ${bridge.pairingCode}`)]); await bridge.flush();
  bridge.ingest([message(2, '/daily 10:00 UTC')]); await bridge.work(); await bridge.flush();
}
const stop = () => { void bridge.close().then(() => host.close()).catch(() => { process.exitCode = 1; }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
now = Date.parse('2026-11-10T10:00:00Z');
await bridge.tick(); await bridge.flush();
console.log(JSON.stringify({ kind: 'recovered', diagnostics: bridge.diagnostics() }));
