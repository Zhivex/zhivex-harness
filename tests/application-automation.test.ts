import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startManagedAssistant} from '../packages/core/src/application/assistant/managed/setup.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {openTelegramStore} from '../packages/core/src/application/assistant/telegram/store.js';
import {createDailyScheduler} from '../packages/core/src/application/assistant/automation/scheduler.js';
import {applicationAutomation} from '../packages/core/src/application/automation.js';
import {connectApplication} from '../packages/core/src/application/client.js';

test('automation configuration is scoped, confirmed, stale-safe and uses persisted scheduler state', async () => {
  const root = await mkdtemp('/tmp/zhx-automation-'); await mkdir(root + '/telegram', {mode: 0o700});
  const store = await openTelegramStore(root + '/telegram'); let queued = 0, linked = true, available = true, stored: string | null = null;
  const scheduler = createDailyScheduler(store, {binding: 'fixture', calendarId: 'primary', async list() {return {events: [], complete: true, nextPageToken: null};}}, () => {queued++;}, () => Date.parse('2026-11-14T00:00:00Z'));
  const manager = await startManagedAssistant(root + '/app', {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: async input => {
    const host = await startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}});
    return {...host, get automation() {return available ? {status: scheduler.status, command: (text: string) => store.transaction(() => scheduler.command(text, 'test-owner'))} : undefined;}, diagnostics: () => ({...host.diagnostics(), telegram: {linked}})} as typeof host;
  }});
  try {
    await manager.action('begin', {}); await manager.action('provider', {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}); await manager.action('start', {});
    const projectId = (await connectApplication(manager.currentHost()!.credentialsPath)).projectId;
    const read = () => applicationAutomation(manager, {projectId});
    const before = await read(); expect(before.state?.schedule).toBeNull();
    const change = {action: 'configure', localTime: '08:00', timeZone: 'UTC', expectedDigest: before.digest, confirmed: true};
    await expect(applicationAutomation(manager, {projectId: 'stale', change})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
    await expect(applicationAutomation(manager, {projectId, change: {...change, confirmed: false}})).rejects.toThrow();
    await expect(applicationAutomation(manager, {projectId, change: {...change, timeZone: 'Bad/Zone'}})).rejects.toThrow();
    expect((await read()).state?.schedule).toBeNull();
    const configured = await applicationAutomation(manager, {projectId, change}); expect(configured.state?.schedule?.enabled).toBe(1); expect(queued).toBe(0);
    await expect(applicationAutomation(manager, {projectId, change})).rejects.toThrow('AUTOMATION_REVIEW_STALE');
    const paused = await applicationAutomation(manager, {projectId, change: {action: 'pause', confirmed: true, expectedDigest: configured.digest}}); expect(paused.state?.schedule?.enabled).toBe(0);
    linked = false;
    await expect(applicationAutomation(manager, {projectId, change: {action: 'resume', confirmed: true, expectedDigest: (await read()).digest}})).rejects.toThrow('AUTOMATION_TELEGRAM_REQUIRED');
    linked = true;
    const forgotten = await applicationAutomation(manager, {projectId, change: {action: 'forget', confirmed: true, expectedDigest: (await read()).digest}}); expect(forgotten.state?.preferences).toHaveLength(0); expect(forgotten.state?.schedule?.enabled).toBe(0);
    expect(store.all('SELECT key FROM personal_preferences')).toHaveLength(0);
    available = false; expect(await read()).toMatchObject({available: false, state: null});
  } finally {await manager.close(); await scheduler.close(); await store.close(); await rm(root, {recursive: true, force: true});}
});
