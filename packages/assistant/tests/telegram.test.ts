import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { GENERAL_ASSISTANT_PROFILE } from '@zhivex-ai/harness/engine';
import { startAssistantHost, createTelegramBridge, createTelegramApi, TelegramFailure, type TelegramApi } from '../src/index.js';

const message = (id: number, text: string, owner = 123, type = 'private') => ({ update_id: id,
  message: { message_id: id + 1, from: { id: owner, is_bot: false }, chat: { id: owner, type }, text } });
const callback = (id: number, data: string, messageId: number, owner = 123) => ({ update_id: id, callback_query: {
  id: `callback-${id}`, from: { id: owner, is_bot: false }, data,
  message: { message_id: messageId, chat: { id: owner, type: 'private' } }
} });
function mockApi() {
  const sent: { id: number; payload: Record<string, any> }[] = [];
  let fail: TelegramFailure | undefined;
  const api: TelegramApi = { async call(method, payload) {
    if (method === 'getMe') return { id: 999, is_bot: true };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'answerCallbackQuery') return true;
    if (method !== 'sendMessage') throw new Error('Unexpected method');
    if (fail) { const error = fail; fail = undefined; throw error; }
    const id = sent.length + 1; sent.push({ id, payload }); return { message_id: id, chat: { id: Number(payload.chat_id) } };
  } };
  return { api, sent, failNext(error: TelegramFailure) { fail = error; } };
}
const profile = { ...GENERAL_ASSISTANT_PROFILE, toolNames: ['apply_reviewed_replacement'] };
const model = (edit = true) => createMockLanguageModel({ streamEvents: edit ? [[
  { type: 'tool-call', toolCall: { id: 'edit', name: 'apply_reviewed_replacement', input: {
    path: 'note.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before').digest('hex'), oldText: 'before', newText: 'after'
  } } }, { type: 'finish', finishReason: 'tool-calls' }
], [{ type: 'text-delta', textDelta: 'Updated' }, { type: 'finish', finishReason: 'stop' }]] : [[
  { type: 'text-delta', textDelta: 'Done' }, { type: 'finish', finishReason: 'stop' }
]] });
async function setup(customModel?: ReturnType<typeof model>) {
  const directory = await mkdtemp('/tmp/assistant-tg-'); const api = mockApi(); let time = Date.now();
  let host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: customModel ?? model(), agentProfile: profile } });
  await writeFile(directory + '/workspace/note.txt', 'before');
  const options = () => ({ stateDirectory: directory + '/state', credentialsPath: host.credentialsPath, ownerId: 'owner',
    expectedTelegramUserId: '123', api: api.api, now: () => time });
  let bridge = await createTelegramBridge(options());
  return { directory, api, get bridge() { return bridge; }, setTime(value: number) { time = value; }, get time() { return time; },
    async pair() { bridge.ingest([message(1, `/start ${bridge.pairingCode}`)]); await bridge.flush(); },
    async restart() { await bridge.close(); await host.close(); host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: model(false), agentProfile: profile } }); bridge = await createTelegramBridge(options()); },
    async close() { await bridge.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
  };
}
function button(f: Awaited<ReturnType<typeof setup>>) {
  const sent = [...f.api.sent].reverse().find(s => s.payload.reply_markup);
  if (!sent) throw new Error('Missing review buttons');
  return { id: sent.id, data: sent.payload.reply_markup.inline_keyboard[0][0].callback_data as string };
}

test('owner pairing excludes strangers/groups and single-use updates stay deduplicated', async () => {
  const f = await setup();
  try {
    const code = f.bridge.pairingCode;
    f.bridge.ingest([message(1, `/start ${code}`, 456), message(2, `/start ${code}`, 123, 'group'), message(3, '/start wrong')]);
    expect(f.bridge.diagnostics().linked).toBe(false); expect(f.api.sent).toHaveLength(0);
    f.bridge.ingest([message(4, `/start ${code}`)]); await f.bridge.flush();
    expect(f.bridge.diagnostics().linked).toBe(true);
    f.bridge.ingest([message(4, `/start ${code}`)]); await f.bridge.work(); await f.bridge.flush();
    expect(f.api.sent).toHaveLength(1);
    f.bridge.ingest([message(5, 'Edit', 456), message(6, 'Edit', 123, 'group')]); await f.bridge.work();
    expect(f.bridge.diagnostics().offset).toBe(7);
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
  } finally { await f.close(); }
});

test('duplicate input and exact chat approval survive restart without repeating effects', async () => {
  const f = await setup();
  try {
    await f.pair(); const input = message(2, 'Change the note');
    f.bridge.ingest([input, input]); await f.bridge.work(); await f.bridge.flush();
    const review = button(f); const count = f.api.sent.length;
    expect(f.api.sent.map(s => s.payload.text).join('\n')).toContain('before');
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
    await f.restart(); f.bridge.ingest([input]); await f.bridge.work(); await f.bridge.flush();
    expect(f.api.sent).toHaveLength(count);
    f.bridge.ingest([callback(3, review.data, review.id, 456), callback(4, review.data, review.id + 100)]);
    await f.bridge.work(); expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
    f.bridge.ingest([callback(5, review.data, review.id)]); await f.bridge.work(); await f.bridge.flush();
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('after');
    const stamp = (await stat(f.directory + '/workspace/note.txt')).mtimeMs;
    await f.restart(); f.bridge.ingest([callback(5, review.data, review.id), callback(6, review.data, review.id)]);
    await f.bridge.work(); await f.bridge.flush();
    expect((await stat(f.directory + '/workspace/note.txt')).mtimeMs).toBe(stamp);
    expect(f.api.sent.some(s => String(s.payload.text).includes('ya se usó'))).toBe(true);
  } finally { await f.close(); }
});

test('expired and stale reviews cannot approve', async () => {
  const f = await setup();
  try {
    await f.pair(); f.bridge.ingest([message(2, 'Change note')]); await f.bridge.work(); await f.bridge.flush();
    const review = button(f);
    f.setTime(f.time + 16 * 60_000); f.bridge.ingest([callback(3, review.data, review.id)]); await f.bridge.work();
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
    f.setTime(Date.now()); await writeFile(f.directory + '/workspace/note.txt', 'changed elsewhere');
    f.bridge.ingest([callback(4, review.data, review.id)]); await f.bridge.work(); await f.bridge.flush();
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('changed elsewhere');
    expect(f.api.sent.some(s => String(s.payload.text).includes('cambió'))).toBe(true);
  } finally { await f.close(); }
});

test('rate-limit retries are durable; uncertain sends are not resent', async () => {
  const f = await setup();
  try {
    f.bridge.ingest([message(1, `/start ${f.bridge.pairingCode}`)]);
    f.api.failNext(new TelegramFailure('retry', 5000)); await f.bridge.flush();
    expect(f.bridge.diagnostics().outbox).toContainEqual({ status: 'retry', count: 1 });
    await f.restart(); await f.bridge.flush(); expect(f.api.sent).toHaveLength(0);
    f.setTime(f.time + 6000); await f.bridge.flush(); expect(f.api.sent).toHaveLength(1);
    f.bridge.ingest([message(2, '/help')]); await f.bridge.work(); f.api.failNext(new TelegramFailure('uncertain')); await f.bridge.flush();
    await f.restart(); await f.bridge.flush(); expect(f.api.sent).toHaveLength(1);
    expect(f.bridge.diagnostics().outbox).toContainEqual({ status: 'uncertain', count: 1 });
  } finally { await f.close(); }
});

test('failed review chunks never produce an approval button', async () => {
  const f = await setup();
  try {
    await f.pair(); f.bridge.ingest([message(2, 'Edit')]); await f.bridge.work();
    f.api.failNext(new TelegramFailure('uncertain')); await f.bridge.flush();
    expect(f.api.sent.some(s => s.payload.reply_markup)).toBe(false);
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
  } finally { await f.close(); }
});

test('persisted sending and unacknowledged run admission reconcile after restart', async () => {
  const f = await setup();
  try {
    await f.pair(); f.bridge.ingest([message(2, 'Edit')]); await f.bridge.work();
    // Simulate the exact durable boundaries immediately before external acknowledgement.
    const db = new DatabaseSync(f.directory + '/state/telegram.sqlite');
    db.prepare("UPDATE outbox SET status='sending' WHERE status='pending'").run();
    db.prepare("UPDATE inbox SET status='processing' WHERE id=2").run(); db.close();
    await f.restart(); await f.bridge.work(); await f.bridge.flush();
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
    expect(f.bridge.diagnostics().inbox).toContainEqual({ status: 'done', count: 2 });
    expect(f.bridge.diagnostics().outbox.some(s => s.status === 'uncertain')).toBe(true);
    const check = new DatabaseSync(f.directory + '/state/telegram.sqlite');
    expect(check.prepare('SELECT COUNT(*) n FROM reviews').get()?.n).toBe(2); check.close();
  } finally { await f.close(); }
});

test('HTTP transport redacts URL errors and rejects redirects / ambiguous server errors', async () => {
  const token = '12345:' + 'a'.repeat(25);
  const api = createTelegramApi(token, (async () => { throw new Error('https://api.telegram.org/bot' + token); }) as unknown as typeof fetch);
  await expect(api.call('sendMessage', {})).rejects.toThrow('TELEGRAM_UNCERTAIN');
  const rateLimited = createTelegramApi(token, (async (_url: string | URL | Request, options?: RequestInit) => {
    expect(options?.redirect).toBe('error');
    return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 10 } }), { status: 429 });
  }) as unknown as typeof fetch);
  try { await rateLimited.call('sendMessage', {}); throw new Error('Expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(TelegramFailure); expect((error as TelegramFailure).retryAfter).toBe(10000); }
});

test('SIGKILL after remote send leaves uncertain delivery and never sends it again', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp('/tmp/assistant-tg-crash-');
  const boot = async (mode: string) => {
    const child = spawn('node', [fileURLToPath(new URL('fixtures/telegram-process.mjs', import.meta.url)), directory, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = once(child, 'exit'); let errors = ''; child.stderr.on('data', part => { errors += part; });
    let timer: ReturnType<typeof setTimeout>;
    try {
      const ready = await Promise.race([
        new Promise<string>(resolve => { let out = ''; child.stdout.on('data', part => { out += part; if (out.includes('\n')) resolve(out.split('\n')[0]!); }); }),
        ended.then(() => { throw new Error(errors || 'Host failed'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Startup timeout')), 15000); })
      ]);
      return { child, ended, ready: JSON.parse(ready) };
    } catch (error) { child.kill('SIGKILL'); await ended; throw error; } finally { clearTimeout(timer!); }
  };
  let host: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    host = await boot('hang');
    await writeFile(directory + '/updates.json', JSON.stringify([message(1, `/start ${host.ready.pairingCode}`)]));
    let sent = false;
    for (let i = 0; i < 300; i++) {
      try { if ((await readFile(directory + '/sends.jsonl', 'utf8')).includes('vinculado')) { sent = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(sent).toBe(true); host.child.kill('SIGKILL'); await host.ended; host = undefined;
    host = await boot('recover');
    expect(host.ready.diagnostics.telegram.outbox).toContainEqual({ status: 'uncertain', count: 1 });
    expect(host.ready.pairingCode).toBeUndefined();
    host.child.kill('SIGTERM'); await host.ended; host = undefined;
    expect((await readFile(directory + '/sends.jsonl', 'utf8')).trim().split('\n')).toHaveLength(1);
  } finally { if (host) { host.child.kill('SIGKILL'); await host.ended; } await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('reject consumes the decision and prevents later approval of the same token', async () => {
  const f = await setup();
  try {
    await f.pair(); f.bridge.ingest([message(2, 'Edit')]); await f.bridge.work(); await f.bridge.flush();
    const review = button(f);
    f.bridge.ingest([callback(3, review.data.replace(/^a:/, 'd:'), review.id)]); await f.bridge.work();
    f.bridge.ingest([callback(4, review.data, review.id)]); await f.bridge.work(); await f.bridge.flush();
    expect(await readFile(f.directory + '/workspace/note.txt', 'utf8')).toBe('before');
    expect(f.api.sent.some(s => String(s.payload.text).includes('ya se usó'))).toBe(true);
  } finally { await f.close(); }
});

test('cancel uses a control lane while a model turn is active', async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const slow = model(false);
  slow.stream = async input => (async function* () {
    began();
    await new Promise<void>(resolve => { if (input.abortSignal?.aborted) resolve(); else input.abortSignal?.addEventListener('abort', () => resolve(), { once: true }); });
    yield { type: 'finish' as const, finishReason: 'stop' as const };
  })();
  const f = await setup(slow);
  try {
    await f.pair(); f.bridge.ingest([message(2, 'Wait for cancellation')]); const work = f.bridge.work(); await started;
    f.bridge.ingest([message(3, '/cancel')]); await f.bridge.work(true); await work; await f.bridge.flush();
    expect(f.api.sent.some(s => String(s.payload.text).includes('cancelled'))).toBe(true);
    expect(f.bridge.diagnostics().inbox).toContainEqual({ status: 'done', count: 3 });
  } finally { await f.close(); }
}, 15_000);
