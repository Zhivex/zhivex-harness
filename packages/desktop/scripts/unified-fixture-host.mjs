// Offline acceptance host: real engine, SQLite, approvals and transport; only the model is simulated.
import { createHarness } from '@zhivex-ai/harness/engine';
import { startApplicationHost } from '@zhivex-ai/harness/application';
import { recoverHarnessLocalService } from '@zhivex-ai/harness/service';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {access, mkdir, writeFile} from 'node:fs/promises';
import {openTelegramStore} from '@zhivex-ai/harness/assistant/telegram/store';
import {createDailyScheduler} from '@zhivex-ai/harness/assistant/automation/scheduler';

const workspace = process.argv[2];
if (!workspace || !path.isAbsolute(workspace)) throw new Error('FIXTURE_WORKSPACE_REQUIRED');
const base = createMockLanguageModel();
const model = { ...base, async stream(input) {
  return (async function* () {
    const last = input.messages.findLastIndex(message => message.role === 'user');
    const hasResult = input.messages.slice(last + 1).some(message => message.role === 'tool');
    const prompt = JSON.stringify(input.messages[last] ?? {});
    if (prompt.includes('wait-for-cancel')) {
      yield { type: 'text-delta', textDelta: 'Waiting for cancellation.' };
      await new Promise(resolve => { if (input.abortSignal?.aborted) resolve(); else input.abortSignal?.addEventListener('abort', resolve, { once: true }); });
      yield { type: 'finish', finishReason: 'stop' }; return;
    }
    if (prompt.includes('shared-edit') && !hasResult) {
      yield { type: 'tool-call', toolCall: { id: `edit-${last}`, name: 'apply_reviewed_replacement', input: {
        path: 'review.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before\n').digest('hex'), oldText: 'before', newText: 'after',
      } } };
      yield { type: 'finish', finishReason: 'tool-calls' }; return;
    }
    yield { type: 'text-delta', textDelta: hasResult ? 'The reviewed change is saved. CLI and desktop share this result.' : 'This conversation is shared with the terminal.' };
    yield { type: 'finish', finishReason: 'stop' };
  })();
} };
const harness = await createHarness({ workspace, provider: 'openai', modelInstance: model, subagentProfiles: [],
  toolPolicy: { schemaVersion: 1, explicitReview: { schemaVersion: 1 }, rules: [] } });
try { await recoverHarnessLocalService(harness, path.join(workspace, 'socket')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const host = await startApplicationHost(harness, { directory: path.join(workspace, 'socket'), maxEvents: 3 });
// Exercise the actual scheduler while Electron is hidden, with an offline agenda/outbox.
await mkdir(path.join(workspace, 'automation'), {recursive: true, mode: 0o700});
const store = await openTelegramStore(path.join(workspace, 'automation'));
store.set('chatId', 'offline-fixture');
let clock = Date.parse('2026-11-15T00:00:00Z'), enqueued = 0, automationFlight;
const scheduler = createDailyScheduler(store, {binding: 'offline', calendarId: 'primary', async list() {return {events: [], complete: true, nextPageToken: null};}}, () => {enqueued++;}, () => clock);
store.transaction(() => scheduler.command('/daily 08:00 UTC', 'fixture-owner'));
const automationTimer = setInterval(() => {
  if (automationFlight) return;
  automationFlight = (async () => {
    if (!await access(path.join(workspace, 'advance-automation')).then(() => true, () => false)) return;
    clock = Date.parse('2026-11-15T08:00:01Z');
    await scheduler.tick();
    await writeFile(path.join(workspace, 'automation-result.json'), JSON.stringify({enqueued, state: scheduler.status()}));
  })().finally(() => {automationFlight = undefined;});
}, 100);
console.log(JSON.stringify({ credentialsPath: host.credentialsPath, pid: process.pid }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; clearInterval(automationTimer); await automationFlight; await scheduler.close(); await store.close(); await host.close(); }
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
