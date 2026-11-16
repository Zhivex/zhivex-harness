import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {openTelegramStore} from '../packages/core/src/application/assistant/telegram/store.js';
import {createDailyScheduler} from '../packages/core/src/application/assistant/automation/scheduler.js';
import {parseCliArgs} from '../packages/core/src/cli/arguments.js';
import {parseCliJsonDocument} from '../packages/core/src/client/json-contracts.js';

test('automation CLI requires scoped stdin review and explicit confirmation', () => {
  expect(parseCliArgs(['automations', 'status', '--json'])).toMatchObject({automationCommand: 'status'});
  expect(parseCliArgs(['automations', 'apply', '-', '--yes'])).toMatchObject({automationCommand: 'apply', yes: true});
  for (const args of [[], ['status', '--yes'], ['apply', '-'], ['apply', '{}', '--yes'], ['status', '--area', 'code'], ['status', '--service', '/tmp/service'], ['status', '--jsonl']]) {
    expect(() => parseCliArgs(['automations', ...args])).toThrow();
  }
});

test('automation CLI shares scheduler state, rejects stale/scope changes and never sends on configuration', async () => {
  const root = await mkdtemp('/tmp/zhx-automation-cli-'); await mkdir(root + '/telegram', {mode: 0o700});
  const store = await openTelegramStore(root + '/telegram'); let queued = 0, linked = true, available = true, stored: string | null = null;
  const scheduler = createDailyScheduler(store, {binding: 'fixture', calendarId: 'primary', async list() {return {events: [], complete: true, nextPageToken: null};}}, () => {queued++;}, () => Date.parse('2026-11-14T00:00:00Z'));
  const owner = await startApplicationCoordinator(root + '/app', {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: async input => {
    const host = await startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}});
    return {...host, get automation() {return available ? {status: scheduler.status, command: (text: string) => store.transaction(() => scheduler.command(text, 'test-owner'))} : undefined;}, diagnostics: () => ({...host.diagnostics(), telegram: {linked}})} as typeof host;
  }});
  const client = await connectCoordinator(root + '/app');
  const cli = async (action: string, input?: unknown, expected = 0) => {
    const child = Bun.spawn([...(process.env.ZHX_CLI_TEST_ENTRY ? ['node', process.env.ZHX_CLI_TEST_ENTRY] : [process.execPath, '--no-env-file', 'packages/core/src/cli.ts']), 'automations', action, ...(action === 'apply' ? ['-', '--yes'] : []), '--application-directory', root + '/app', '--json'], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    child.stdin.write(input === undefined ? '' : JSON.stringify(input)); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(expected);
    const result = JSON.parse(code === 0 ? stdout : stderr);
    if (code === 0) parseCliJsonDocument(result);
    return result;
  };
  try {
    await client.call('action', {name: 'begin', value: {}});
    await client.call('action', {name: 'provider', value: {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}});
    await client.call('action', {name: 'start', value: {}});
    const before = await cli('status'); expect(before).toMatchObject({available: true, linked: true, state: {schedule: null}});
    const input = {projectId: before.projectId, change: {action: 'configure', localTime: '08:00', timeZone: 'UTC', expectedDigest: before.digest}};
    await cli('apply', {...input, change: {...input.change, timeZone: 'Bad/Zone'}}, 2);
    await cli('apply', {...input, projectId: 'wrong-project'}, 2);
    expect(scheduler.status().schedule).toBeNull();
    const configured = await cli('apply', input); expect(configured.state.schedule.enabled).toBe(1);
    expect(await client.call('automation', {projectId: before.projectId})).toMatchObject({digest: configured.digest, state: configured.state});
    expect(await cli('apply', input, 2)).toMatchObject({error: {code: 'CONFIG_INVALID'}});
    expect((await cli('status')).digest).toBe(configured.digest);
    const paused = await cli('apply', {projectId: before.projectId, change: {action: 'pause', expectedDigest: configured.digest}});
    expect(paused.state.schedule.enabled).toBe(0);
    linked = false;
    expect(await cli('apply', {projectId: before.projectId, change: {action: 'resume', expectedDigest: (await cli('status')).digest}}, 2)).toMatchObject({error: {code: 'CONFIG_INVALID'}});
    expect(scheduler.status().schedule?.enabled).toBe(0);
    linked = true;
    const resumed = await cli('apply', {projectId: before.projectId, change: {action: 'resume', expectedDigest: (await cli('status')).digest}});
    expect(resumed.state.schedule.enabled).toBe(1);
    const deleted = await cli('apply', {projectId: before.projectId, change: {action: 'delete', expectedDigest: resumed.digest}});
    expect(deleted.state.schedule).toBeNull();
    const forgotten = await cli('apply', {projectId: before.projectId, change: {action: 'forget', expectedDigest: deleted.digest}});
    expect(forgotten.state.preferences).toHaveLength(0);
    expect(queued).toBe(0);
    available = false; expect(await cli('status')).toMatchObject({available: false, state: null});
  } finally {await owner.close(); await scheduler.close(); await store.close(); await rm(root, {recursive: true, force: true});}
}, 30000);
