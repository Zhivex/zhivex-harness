import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createDailyScheduler } from '../src/automation/scheduler.js';
import { dailySummary, type AgendaSource } from '../src/automation/summary.js';
import { dayWindow, nextDaily } from '../src/automation/time.js';
import { openTelegramStore } from '../src/telegram/store.js';
import { startAssistantHost, createTelegramBridge, TelegramFailure, type TelegramApi } from '../src/index.js';

const epoch = (value: string) => Date.parse(value);
const event = (id: string, start: string, end: string, extra = {}) => ({ id, summary: id, start: { dateTime: start }, end: { dateTime: end }, ...extra });
const source = (list?: AgendaSource['list']): AgendaSource => ({ binding: 'account1:primary', calendarId: 'primary', list: list ?? (async () => ({ events: [], nextPageToken: null, complete: true })) });
async function fixture(agenda = source()) {
  const directory = await mkdtemp('/tmp/asched-'); let time = epoch('2026-11-10T09:00:00Z');
  let store = await openTelegramStore(directory); store.set('chatId', '123');
  const enqueue = (id: string, text: string) => store.run('INSERT OR IGNORE INTO outbox(id,sequence,payload) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM outbox),?)', id + ':0', text);
  let scheduler = createDailyScheduler(store, agenda, enqueue, () => time);
  return { directory, get store() { return store; }, get scheduler() { return scheduler; }, setTime(value: string) { time = epoch(value); },
    command(value: string) { return store.transaction(() => scheduler.command(value, 1)); },
    async restart() { await scheduler.close(); await store.close(); store = await openTelegramStore(directory); scheduler = createDailyScheduler(store, agenda, enqueue, () => time); },
    async close() { await scheduler.close(); await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('daily time handles zones, DST gaps/folds and skipped dates', () => {
  const spring = dayWindow('2026-03-08', 'America/New_York', '02:30')!;
  expect(new Date(spring.due).toISOString()).toBe('2026-03-08T07:00:00.000Z');
  expect(spring.end - spring.start).toBe(23 * 3600_000);
  const fall = dayWindow('2026-11-01', 'America/New_York', '01:30')!;
  expect(new Date(fall.due).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  expect(fall.end - fall.start).toBe(25 * 3600_000);
  expect(nextDaily(fall.due, 'America/New_York', '01:30')).toBe(epoch('2026-11-02T06:30:00Z'));
  expect(dayWindow('2011-12-30', 'Pacific/Apia')).toBeNull();
  expect(new Date(dayWindow('2026-11-10', 'Asia/Kathmandu', '08:00')!.due).toISOString()).toBe('2026-11-10T02:15:00.000Z');
});

test('persistent daily occurrence catches up today once, skips prior days and survives restart before delivery', async () => {
  let reads = 0; const f = await fixture(source(async () => { reads++; return { events: [], complete: true, nextPageToken: null }; }));
  try {
    f.command('/daily 08:00 America/Argentina/Buenos_Aires');
    await f.scheduler.tick(); expect(reads).toBe(0);
    f.setTime('2026-11-10T12:00:00Z'); await f.restart();
    await Promise.all([f.scheduler.tick(), f.scheduler.tick()]); expect(reads).toBe(1);
    expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
    await f.restart(); await f.scheduler.tick(); expect(reads).toBe(1);
    f.setTime('2026-11-14T12:00:00Z'); await f.restart(); await f.scheduler.tick(); expect(reads).toBe(2);
    expect(f.store.all('SELECT day FROM daily_occurrences ORDER BY day')).toEqual([{ day: '2026-11-10' }, { day: '2026-11-14' }]);
    f.command('/daily delete'); f.command('/daily 10:00 America/Argentina/Buenos_Aires');
    f.setTime('2026-11-14T14:00:00Z'); await f.scheduler.tick(); expect(reads).toBe(2);
  } finally { await f.close(); }
});

test('preferences have provenance, correction never enables paused automation, forgetting pauses and cancels delivery', async () => {
  const f = await fixture();
  try {
    f.command('/daily 10:00 UTC'); f.command('/memory set conflictBufferMinutes 15');
    expect(f.command('/memory list')).toContain('telegram-owner:1');
    expect(f.command('/memory set calendarId other')).toContain('inválida');
    f.setTime('2026-11-10T10:00:00Z'); await f.scheduler.tick();
    f.command('/daily pause'); expect(f.store.get<{ status: string }>('SELECT status FROM outbox')?.status).toBe('cancelled');
    f.command('/memory set localTime 11:00'); expect(f.scheduler.status().schedule?.enabled).toBe(0);
    f.command('/memory forget timeZone'); expect(f.command('/memory list')).not.toContain('timeZone');
    expect(f.command('/daily resume')).toContain('Faltan');
    f.command('/memory forget all'); expect(f.scheduler.status().preferences).toEqual([]);
    f.command('/daily delete'); expect(f.scheduler.status().schedule).toBeNull();
    await f.restart(); expect(f.scheduler.status().preferences).toEqual([]);
  } finally { await f.close(); }
});

test('in-flight reads cannot deliver after pause or preference revision', async () => {
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture(source(async () => { began(); await new Promise<void>(resolve => { release = resolve; }); return { events: [], nextPageToken: null, complete: true }; }));
  try {
    f.command('/daily 10:00 UTC'); f.setTime('2026-11-10T10:00:00Z');
    const tick = f.scheduler.tick(); await started; f.command('/daily pause'); release(); await tick;
    expect(f.store.all('SELECT * FROM outbox')).toEqual([]);
    expect(f.scheduler.status().occurrences).toContainEqual(expect.objectContaining({ status: 'cancelled' }));
  } finally { await f.close(); }
});

test('read failures have bounded retries persisted across restart and never report an empty agenda', async () => {
  let calls = 0; const f = await fixture(source(async () => { calls++; throw new Error('sensitive provider error'); }));
  try {
    f.command('/daily 10:00 UTC'); f.setTime('2026-11-10T10:00:00Z'); await f.scheduler.tick(); await f.scheduler.tick(); expect(calls).toBe(1);
    await f.restart(); f.setTime('2026-11-10T10:05:00Z'); await f.scheduler.tick();
    f.setTime('2026-11-10T10:10:00Z'); await f.scheduler.tick(); await f.scheduler.tick(); expect(calls).toBe(3);
    const rows = f.store.all<{ payload: string }>('SELECT payload FROM outbox'); expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toContain('agenda completa'); expect(rows[0]!.payload).not.toContain('sensitive');
    expect(f.scheduler.status().occurrences).toContainEqual(expect.objectContaining({ status: 'failed', attempts: 3 }));
  } finally { await f.close(); }
});

test('interrupted read resumes but a persisted third attempt never exceeds its budget', async () => {
  const f = await fixture();
  try {
    f.command('/daily 10:00 UTC');
    f.store.run("INSERT INTO daily_occurrences VALUES('daily:2026-11-10','2026-11-10',1,'building',3,0)");
    f.store.run('UPDATE daily_schedule SET next_at=?', epoch('2026-11-11T10:00:00Z'));
    f.setTime('2026-11-10T10:00:00Z'); await f.restart(); await f.scheduler.tick();
    expect(f.scheduler.status().occurrences).toContainEqual(expect.objectContaining({ status: 'failed', attempts: 3 }));
  } finally { await f.close(); }
});

test('summary follows pages, includes all-day conflicts, excludes free events and applies explicit margin', async () => {
  let page = 0;
  const agenda = source(async input => {
    expect(input.timeMin).toBe('2026-11-10T00:00:00.000Z');
    page++;
    return page === 1 ? { events: [event('One', '2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z')], nextPageToken: 'two', complete: false } :
      { events: [event('Two', '2026-11-10T11:05:00Z', '2026-11-10T12:00:00Z'),
        event('Free', '2026-11-10T10:00:00Z', '2026-11-10T12:00:00Z', { busy: false }),
        { id: 'day', summary: 'All day', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }], nextPageToken: null, complete: true };
  });
  const body = await dailySummary(agenda, '2026-11-10', 'UTC', 10, new AbortController().signal);
  expect(page).toBe(2); expect(body).toContain('3 conflictos'); expect(body).toContain('Todo el día'); expect(body).not.toContain('↔ Free');
  await expect(dailySummary(source(async () => ({ events: [], complete: false, nextPageToken: 'same' })), '2026-11-10', 'UTC', 0, new AbortController().signal)).rejects.toThrow('INCOMPLETE');
});

const message = (id: number, text: string, owner = 123) => ({ update_id: id, message: { message_id: id, from: { id: owner }, chat: { id: owner, type: 'private' }, text } });
test('owner commands and daily delivery use durable Telegram outbox with restart, dedup and uncertain-send protection', async () => {
  const directory = await mkdtemp('/tmp/adaily-'); let time = epoch('2026-11-10T09:00:00Z'), sends = 0, uncertain = false, reads = 0;
  const texts: string[] = [];
  const api: TelegramApi = { async call(method, payload) {
    if (method === 'getMe') return { id: 999, is_bot: true };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'sendMessage') { texts.push(String(payload.text)); sends++; if (uncertain) throw new TelegramFailure('uncertain'); return { message_id: sends, chat: { id: 123 } }; }
    return true;
  } };
  let host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: createMockLanguageModel() } });
  const opts = () => ({ stateDirectory: directory + '/state', credentialsPath: host.credentialsPath, ownerId: 'owner', expectedTelegramUserId: '123', api, now: () => time,
    agendaSource: source(async () => { reads++; return { events: [], nextPageToken: null, complete: true }; }) });
  let bridge = await createTelegramBridge(opts());
  const restart = async () => { await bridge.close(); await host.close(); host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: createMockLanguageModel() } }); bridge = await createTelegramBridge(opts()); };
  try {
    bridge.ingest([message(1, `/start ${bridge.pairingCode}`)]); await bridge.flush();
    bridge.ingest([message(2, '/daily 10:00 UTC', 456)]); await bridge.work(); expect(bridge.diagnostics().automation?.schedule).toBeNull();
    const enable = message(3, '/daily 10:00 UTC'); bridge.ingest([enable, enable]); await bridge.work(); await bridge.flush();
    expect(bridge.diagnostics().automation?.schedule?.revision).toBe(1);
    time = epoch('2026-11-10T10:00:00Z'); await restart(); await bridge.tick(); expect(reads).toBe(1);
    await restart(); await bridge.tick(); await bridge.flush(); expect(reads).toBe(1);
    expect(texts.filter(text => text.startsWith('Agenda '))).toHaveLength(1);
    time = epoch('2026-11-11T10:00:00Z'); uncertain = true; await bridge.tick(); await bridge.flush();
    await restart(); uncertain = false; await bridge.tick(); await bridge.flush();
    expect(texts.filter(text => text.startsWith('Agenda '))).toHaveLength(2);
    expect(bridge.diagnostics().outbox).toContainEqual({ status: 'uncertain', count: 1 });
    time = epoch('2026-11-12T10:00:00Z'); await bridge.tick(); // queued, never sent
    time = epoch('2026-11-13T10:00:00Z'); await restart(); await bridge.flush();
    expect(texts.filter(text => text.startsWith('Agenda '))).toHaveLength(2);
    expect(bridge.diagnostics().outbox).toContainEqual({ status: 'expired', count: 1 });
  } finally { await bridge.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);

test('SIGKILL during daily read recovers the same occurrence in a new Node process', async () => {
  const { spawn } = await import('node:child_process'); const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url'); const { readFile } = await import('node:fs/promises');
  const directory = await mkdtemp('/tmp/adaily-crash-');
  const boot = async (mode: string) => {
    const child = spawn('node', [fileURLToPath(new URL('fixtures/daily-process.mjs', import.meta.url)), directory, mode], { stdio: ['ignore','pipe','pipe'] });
    const ended = once(child, 'exit'); let stderr = '', timer: ReturnType<typeof setTimeout>;
    child.stderr.on('data', part => { stderr += part; });
    try {
      const ready = await Promise.race([
        new Promise<string>(resolve => { let out = ''; child.stdout.on('data', part => { out += part; if (out.includes('\n')) resolve(out.split('\n')[0]!); }); }),
        ended.then(() => { throw new Error(stderr || 'Process exited'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Startup timeout')), 15000); })
      ]);
      return { child, ended, ready: JSON.parse(ready) };
    } catch (error) { child.kill('SIGKILL'); await ended; throw error; } finally { clearTimeout(timer!); }
  };
  let child: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    child = await boot('hang'); expect(child.ready.kind).toBe('reading');
    child.child.kill('SIGKILL'); await child.ended; child = undefined;
    child = await boot('recover'); expect(child.ready.diagnostics.automation.occurrences).toContainEqual(expect.objectContaining({ id: 'daily:2026-11-10', status: 'enqueued', attempts: 2 }));
    child.child.kill('SIGTERM'); await child.ended; child = undefined;
    child = await boot('normal'); child.child.kill('SIGTERM'); await child.ended; child = undefined;
    expect((await readFile(directory + '/reads.jsonl', 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await readFile(directory + '/sends.jsonl', 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.text.startsWith('Agenda '))).toHaveLength(1);
  } finally { if (child) { child.child.kill('SIGKILL'); await child.ended; } await rm(directory, { recursive: true, force: true }); }
}, 30000);
