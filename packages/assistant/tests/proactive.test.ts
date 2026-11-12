import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDailyService } from '../src/daily/service.js';
import type { AgendaEvent, AgendaSource } from '../src/automation/summary.js';
import type { ReplySource } from '../src/proactive/service.js';
import { createDailyModule } from '../src/modules/daily.js';
import { openAssistantModules } from '../src/modules/module.js';

const policy = { enabled: true, timeZone: 'UTC', channel: 'web', calendar: false, tasks: true, replies: false, quietStart: '22:00', quietEnd: '08:00', maxPerDay: 5 };
async function fixture() {
  const directory = await mkdtemp('/tmp/proactive-'); let time = Date.parse('2026-11-11T09:00:00Z');
  let daily = await openDailyService(directory, 'owner', false, () => time);
  return { directory, get daily() { return daily; }, get p() { return daily.proactive; }, get time() { return time; },
    advance(ms = 5 * 60000) { time += ms; }, set(value: string) { time = Date.parse(value); },
    async restart() { await daily.close(); daily = await openDailyService(directory, 'owner', false, () => time); },
    async close() { await daily.close(); await rm(directory, { force: true, recursive: true }); } };
}
function event(id: string, start = '10:00', end = '11:00'): AgendaEvent { return { id, summary: id, start: { dateTime: `2026-11-11T${start}:00Z` }, end: { dateTime: `2026-11-11T${end}:00Z` } }; }
const agenda = (events: AgendaEvent[]): AgendaSource => ({ binding: 'calendar1', calendarId: 'primary', async list() { return { events, complete: true, nextPageToken: null }; } });
const watch = () => ({ requestId: randomUUID(), source: 'google', threadId: 'thread1', baselineMessageId: 'sent1', expectedFrom: 'them@example.com', title: 'Budget', dueAt: '2026-11-11T10:00:00Z' });
const baseline = { id: 'sent1', from: 'me@example.com', at: Date.parse('2026-11-11T08:00:00Z'), draft: false };

test('disabled by default; task stages, concurrent ticks and restart do not duplicate', async () => {
  const f = await fixture();
  try {
    const task = { requestId: randomUUID(), title: 'Deliver proposal', dueDate: '2026-11-12' }; f.daily.createTask(task);
    await f.p.tick(); expect(f.p.status().alerts).toHaveLength(0);
    f.p.configure(policy); await Promise.all([f.p.tick(), f.p.tick()]);
    expect(f.p.status().alerts).toHaveLength(1); expect(f.p.status().alerts[0]?.text).toContain('vence mañana');
    await f.restart(); f.advance(); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    f.set('2026-11-12T09:05:00Z'); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(2);
    f.daily.completeTask({ requestId: randomUUID(), taskId: task.requestId }); f.advance(); await f.p.tick();
    expect(f.p.status().alerts.some(a => a.status === 'available')).toBe(false);
  } finally { await f.close(); }
});

test('quiet hours and daily/rolling quota survive restart and timezone changes', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) f.daily.createTask({ requestId: randomUUID(), title: `task${i}`, dueDate: '2026-11-11' });
    f.set('2026-11-11T23:00:00Z'); f.p.configure({ ...policy, maxPerDay: 1 }); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(0);
    f.set('2026-11-12T08:00:00Z'); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    await f.restart(); f.p.configure({ ...policy, maxPerDay: 1, timeZone: 'Pacific/Auckland', quietStart: '00:00', quietEnd: '00:00' });
    await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    f.advance(86400_001); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(2);
  } finally { await f.close(); }
});

test('calendar paginates, ignores free/cancelled events and resolves changed conflicts', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.p.bind({ agenda: { binding: 'cal1', calendarId: 'primary', async list(input) { calls++; return input.pageToken ? { events: [event('b', '10:30', '11:30'), { ...event('free'), busy: false }, { ...event('cancel'), status: 'cancelled' }], complete: true, nextPageToken: null } : { events: [event('a')], complete: false, nextPageToken: 'next' }; } } });
    f.p.configure({ ...policy, calendar: true, tasks: false }); await f.p.tick();
    expect(calls).toBe(2); expect(f.p.status().alerts).toHaveLength(1);
    f.advance(); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    f.p.bind({ agenda: agenda([event('a'), event('b', '11:00', '12:00')]) }); f.advance(); await f.p.tick();
    expect(f.p.status().alerts[0]?.status).toBe('resolved');
    f.p.configure({ ...policy, calendar: true, bufferMinutes: 15 }); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(2);
  } finally { await f.close(); }
});

test('partial calendar reads emit no false findings and do not block task alerts', async () => {
  const f = await fixture();
  try {
    f.daily.createTask({ requestId: randomUUID(), title: 'Today', dueDate: '2026-11-11' });
    f.p.bind({ agenda: { binding: 'cal', calendarId: 'primary', async list() { return { events: [event('a'), event('b')], complete: false, nextPageToken: 'loop' }; } } });
    f.p.configure({ ...policy, calendar: true }); await f.p.tick();
    expect(f.p.status().alerts.map(a => a.kind)).toEqual(['task']);
    expect(f.p.status().health).toContainEqual(expect.objectContaining({ source: 'calendar', status: 'unavailable' }));
  } finally { await f.close(); }
});

test('pause or reconfiguration during an external read invalidates its result', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), begin = new Promise<void>(resolve => { started = resolve; });
  try {
    f.p.bind({ agenda: { ...agenda([]), async list() { started(); await wait; return { events: [event('a'), event('b')], complete: true, nextPageToken: null }; } } });
    f.p.configure({ ...policy, calendar: true }); const tick = f.p.tick(); await begin;
    f.p.configure({ ...policy, enabled: false }); release(); await tick; expect(f.p.status().alerts).toHaveLength(0);
  } finally { release(); await f.close(); }
});

test('explicit reply watch ignores drafts, earlier mail and other senders; closes on matching reply', async () => {
  const f = await fixture(); const messages = [baseline];
  const source: ReplySource = { id: 'google', binding: 'mail1', async read() { return { complete: true, messages }; } };
  try {
    f.p.bind({ replies: [source] }); const input = watch(); f.p.watch(input); expect(f.p.watch(input)).toEqual({ watchId: input.requestId });
    expect(() => f.p.watch({ ...input, title: 'different' })).toThrow('REQUEST_CONFLICT');
    f.p.configure({ ...policy, tasks: false, replies: true }); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(0);
    messages.push({ id: 'draft', from: input.expectedFrom, at: baseline.at + 1, draft: true }, { id: 'other', from: 'other@example.com', at: baseline.at + 2, draft: false }, { id: 'old', from: input.expectedFrom, at: baseline.at - 1, draft: false });
    f.set('2026-11-11T10:00:00Z'); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    await f.restart(); f.p.bind({ replies: [source] }); f.advance(); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    messages.push({ id: 'reply', from: 'Person <THEM@example.com>', at: baseline.at + 1000, draft: false });
    f.advance(); await f.p.tick(); expect(f.p.status().watches[0]?.status).toBe('replied'); expect(f.p.status().alerts[0]?.status).toBe('resolved');
  } finally { await f.close(); }
});

test('reply watches reject duplicate intents, detect missing baseline and account changes, and cancel durably', async () => {
  const f = await fixture();
  try {
    const source: ReplySource = { id: 'google', binding: 'mail1', async read() { return { complete: true, messages: [] }; } };
    f.p.bind({ replies: [source] }); const input = watch(); f.p.watch(input);
    expect(() => f.p.watch({ ...input, requestId: randomUUID() })).toThrow('WATCH_EXISTS');
    f.p.configure({ ...policy, replies: true }); f.set('2026-11-11T11:00:00Z'); await f.p.tick();
    expect(f.p.status().alerts).toHaveLength(0); expect(f.p.status().health[0]?.status).toBe('unavailable');
    f.p.bind({ replies: [{ ...source, binding: 'different-account', async read() { throw new Error('must not read'); } }] }); f.advance(); await f.p.tick();
    expect(f.p.status().alerts).toHaveLength(0);
    f.p.cancelWatch({ watchId: input.requestId }); await f.restart(); expect(f.p.status().watches[0]?.status).toBe('cancelled');
  } finally { await f.close(); }
});

test('uncertain Telegram delivery and crashed sending state never replay', async () => {
  const f = await fixture(); let sends = 0;
  try {
    f.p.setDelivery({ ready: () => true, async send() { sends++; throw new Error('lost response'); } });
    f.daily.createTask({ requestId: randomUUID(), title: 'Task', dueDate: '2026-11-11' });
    f.p.configure({ ...policy, channel: 'telegram' }); await f.p.tick(); expect(sends).toBe(1); expect(f.p.status().alerts[0]?.status).toBe('uncertain');
    await f.daily.close();
    const db = new DatabaseSync(f.directory + '/daily/telegram.sqlite'); db.exec("UPDATE proactive_alerts SET status='sending'"); db.close();
    await f.restart(); f.p.setDelivery({ ready: () => true, async send() { sends++; } }); f.advance(); await f.p.tick();
    expect(sends).toBe(1); expect(f.p.status().alerts[0]?.status).toBe('uncertain');
  } finally { await f.close(); }
});

test('read-only detector capabilities are wired without changing legacy daily profile', async () => {
  const directory = await mkdtemp('/tmp/proactive-modules-');
  let modules;
  try {
    modules = await openAssistantModules([createDailyModule()], { directory, ownerId: 'owner', recover: false });
    expect(modules.profile.toolNames).not.toContain('daily_write_watch_reply'); await modules.close();
    modules = await openAssistantModules([createDailyModule({ proactive: true })], { directory, ownerId: 'owner', recover: false });
    expect(modules.profile.toolNames).toContain('daily_write_watch_reply');
    expect(modules.engine.mcpConfiguration.servers.find(s => s.name === 'daily_write')?.permissions).toContain('write');
    expect(modules.daily?.proactive.status().policy).toBeNull();
  } finally { await modules?.close(); await rm(directory, { force: true, recursive: true }); }
});

test('proactive activation requires exact Harness approval and survives host restart', async () => {
  const { createMockLanguageModel } = await import('@zhivex-ai/agents/testing');
  const { startAssistantHost } = await import('../src/host.js');
  const { connectAssistant } = await import('../src/client.js');
  const directory = await mkdtemp('/tmp/proactive-host-'); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    host = await startAssistantHost({ directory, ownerId: 'owner', modules: [createDailyModule({ proactive: true })], engine: { modelInstance: createMockLanguageModel({ streamEvents: [
      [{ type: 'tool-call', toolCall: { id: 'policy1', name: 'daily_write_configure_proactive', input: { ...policy, bufferMinutes: 0 } } }, { type: 'finish', finishReason: 'tool-calls' }],
      [{ type: 'text-delta', textDelta: 'Configured' }, { type: 'finish', finishReason: 'stop' }],
    ] }) } });
    let client = await connectAssistant(host.credentialsPath);
    const created = await client.command({ method: 'session.create', title: 'Proactive', idempotencyKey: 'session' });
    if (!created.ok || created.data.kind !== 'session') throw new Error('SESSION_FAILED'); const session = created.data.session;
    const pending = await client.command({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Enable proactive task alerts' });
    expect(pending).toMatchObject({ ok: true, data: { run: { status: 'waiting_approval' } } });
    expect(host.daily?.proactive.status().policy).toBeNull();
    if (!pending.ok || pending.data.kind !== 'run') throw new Error('RUN_FAILED');
    await host.close();
    host = await startAssistantHost({ directory, ownerId: 'owner', modules: [createDailyModule({ proactive: true })], engine: { modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Activated' }, { type: 'finish', finishReason: 'stop' }]] }) } });
    client = await connectAssistant(host.credentialsPath);
    const current = await client.command({ method: 'run.get', sessionId: session.sessionId, runId: pending.data.run.runId, includeReview: true });
    if (!current.ok || current.data.kind !== 'run') throw new Error('RUN_FAILED');
    expect(await client.command({ method: 'approval.resolve', sessionId: session.sessionId, runId: current.data.run.runId, expectedRevision: current.data.run.revision, idempotencyKey: 'approve', decisions: current.data.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) })).toMatchObject({ ok: true });
    expect(host.daily?.proactive.status().policy).toMatchObject(policy);
  } finally { await host?.close(); await rm(directory, { force: true, recursive: true }); }
});

test('daytime silence and DST folds preserve the local quiet window', async () => {
  const f = await fixture();
  try {
    f.daily.createTask({ requestId: randomUUID(), title: 'Overdue', dueDate: '2026-10-31' });
    f.p.configure({ ...policy, timeZone: 'America/New_York', quietStart: '01:00', quietEnd: '02:00' });
    f.set('2026-11-01T05:30:00Z'); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(0);
    f.set('2026-11-01T06:30:00Z'); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(0);
    f.set('2026-11-01T07:00:00Z'); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
  } finally { await f.close(); }
});

test('calendar detects all-day conflicts and ignores invalid/incomplete snapshots', async () => {
  const f = await fixture();
  try {
    f.p.bind({ agenda: agenda([{ id: 'day', summary: 'Vacation', start: { date: '2026-11-11' }, end: { date: '2026-11-12' } }, event('meeting')]) });
    f.p.configure({ ...policy, calendar: true }); await f.p.tick(); expect(f.p.status().alerts).toHaveLength(1);
    f.p.bind({ agenda: agenda([event('invalid', '12:00', '11:00')]) }); f.advance(); await f.p.tick();
    expect(f.p.status().alerts[0]?.status).toBe('available');
    expect(f.p.status().health).toContainEqual(expect.objectContaining({ source: 'calendar', status: 'unavailable' }));
  } finally { await f.close(); }
});

test('cancelling a watch while its read is in flight suppresses its notice', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), begin = new Promise<void>(resolve => { started = resolve; });
  try {
    f.p.bind({ replies: [{ id: 'google', binding: 'mail1', async read() { started(); await waiting; return { complete: true, messages: [baseline] }; } }] });
    const input = watch(); f.p.watch(input); f.p.configure({ ...policy, replies: true }); f.set('2026-11-11T11:00:00Z');
    const tick = f.p.tick(); await begin; f.p.cancelWatch({ watchId: input.requestId }); release(); await tick;
    expect(f.p.status().alerts).toHaveLength(0); expect(f.p.status().watches[0]?.status).toBe('cancelled');
  } finally { release(); await f.close(); }
});
