import { appendFile, readFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startAssistantHost } from '../../dist/index.js';
const [directory, mode] = process.argv.slice(2);
const api = { async call(method, payload, signal) {
  if (method === 'getMe') return { id: 999, is_bot: true };
  if (method === 'getWebhookInfo') return { url: '' };
  if (method === 'getUpdates') {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (signal?.aborted) return [];
    let updates = [];
    try { updates = JSON.parse(await readFile(directory + '/updates.json', 'utf8')); } catch {}
    return updates.filter(update => update.update_id >= payload.offset);
  }
  if (method === 'sendMessage') {
    await appendFile(directory + '/sends.jsonl', JSON.stringify(payload) + '\n');
    if (mode === 'hang') await new Promise(() => {});
    return { message_id: 1, chat: { id: 123 } };
  }
  return true;
} };
try {
  const host = await startAssistantHost({ directory, ownerId: 'owner', recover: mode === 'recover',
    engine: { modelInstance: createMockLanguageModel() }, telegram: { token: 'unused-fixture', expectedUserId: '123', api } });
  console.log(JSON.stringify({ pairingCode: host.pairingCode, diagnostics: host.diagnostics() }));
  const stop = () => { void host.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch (error) { console.error(error.message); process.exitCode = 1; }
