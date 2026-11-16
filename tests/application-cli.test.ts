import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {parseCliArgs} from '../packages/core/src/cli/arguments.js';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {parseCliJsonDocument, parseCliJsonLineDocument} from '../packages/core/src/client/json-contracts.js';

test('application CLI parser keeps host authority, explicit shutdown and literal prompts', () => {
  expect(parseCliArgs(['run', '--area', 'assistant', '--', '--model'])).toMatchObject({applicationArea: 'assistant', prompt: '--model'});
  expect(parseCliArgs(['application', 'stop', '--yes'])).toMatchObject({applicationCommand: 'stop', yes: true});
  expect(() => parseCliArgs(['agents', 'tools', 'inline-json'])).toThrow();
  expect(() => parseCliArgs(['application', 'stop'])).toThrow('requires --yes');
  expect(() => parseCliArgs(['run', '--area', 'assistant', '--service', '/tmp/f', 'hi'])).toThrow();
  expect(() => parseCliArgs(['run', '--area', 'assistant', '--provider', 'openai', 'hi'])).toThrow();
  expect(() => parseCliArgs(['run', '--area', 'unknown', 'hi'])).toThrow();
  expect(() => parseCliArgs(['application', 'status', '--area', 'code'])).toThrow();
});

test('CLI discovers the desktop coordinator, preserves JSONL/stdin and sessions, and stops only on explicit request', async () => {
  const directory = await mkdtemp('/tmp/zhx-app-cli-'); let stored: string | null = null;
  const owner = await startApplicationCoordinator(directory, {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {},
    startHost: input => startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel({streamEvents: [[{type: 'text-delta', textDelta: 'Shared CLI result'}, {type: 'finish', finishReason: 'stop'}]]})}})});
  const client = await connectCoordinator(directory);
  const cli = async (args: string[], input = '') => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'packages/core/src/cli.ts', ...args, '--application-directory', directory], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    child.stdin.write(input); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); if (code !== 0) throw new Error(stdout); expect(code).toBe(0); return stdout;
  };
  try {
    await client.call('action', {name: 'begin', value: {}});
    await client.call('action', {name: 'provider', value: {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture-key'}});
    await client.call('action', {name: 'start', value: {}});
    const lines = (await cli(['run', '--area', 'assistant', '--jsonl', '-'], 'A task from stdin')).trim().split('\n').map(line => parseCliJsonLineDocument(JSON.parse(line)));
    expect(lines.at(-1)).toMatchObject({kind: 'run-stream-result', status: 'completed'});
    const sessions = JSON.parse(await cli(['sessions', 'list', '--area', 'assistant', '--json']));
    parseCliJsonDocument(sessions); expect(sessions.sessions).toHaveLength(1);
    expect((await client.state()).state.ready).toBe(true);
    expect(parseCliJsonDocument(JSON.parse(await cli(['application', 'status', '--json'])))).toMatchObject({kind: 'application-status', status: 'running', assistantReady: true});
    expect(parseCliJsonDocument(JSON.parse(await cli(['application', 'stop', '--yes', '--json'])))).toMatchObject({status: 'stop-requested'});
    await owner.close();
    expect(parseCliJsonDocument(JSON.parse(await cli(['application', 'status', '--json'])))).toMatchObject({status: 'unavailable'});
  } finally {await owner.close(); await rm(directory, {recursive: true, force: true});}
}, 20000);

test('CLI manages agent drafts, shared connections and Git projects without a desktop or exposing provider secrets', async () => {
  const {mkdir} = await import('node:fs/promises');
  const {execFileSync} = await import('node:child_process');
  const directory = await mkdtemp('/tmp/zhx-management-'); let stored: string | null = null;
  for (const name of ['a', 'b']) {await mkdir(directory + '/' + name); execFileSync('git', ['-C', directory + '/' + name, 'init', '-q']);}
  const owner = await startApplicationCoordinator(directory, {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: input => startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}})});
  const client = await connectCoordinator(directory);
  const secret = 'management-fixture-secret';
  const cli = async (args: string[], input = '', expected = 0) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'packages/core/src/cli.ts', ...args, '--application-directory', directory, '--json'], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    child.stdin.write(input); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout + stderr).not.toContain(secret); expect(code).toBe(expected);
    const document = JSON.parse(expected === 0 ? stdout : stderr); if (expected === 0) parseCliJsonDocument(document); return document;
  };
  try {
    expect(await cli(['agents', 'list'])).toMatchObject({agents: [], draft: null});
    expect(await cli(['agents', 'create', 'First assistant'])).toMatchObject({draft: {name: 'First assistant'}});
    await expect(client.call('management', {resource: 'agents', action: 'create', args: ['Do not overwrite']})).rejects.toThrow('SETUP_DRAFT_PENDING');
    expect((await client.state()).state.draftName).toBe('First assistant');
    const configured = await cli(['connections', 'configure', '-'], JSON.stringify({baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: secret}));
    expect(configured.connections).toHaveLength(1); const connectionId = configured.connections[0].id;
    expect(await cli(['agents', 'tools', '-'], JSON.stringify({daily: true, proactive: false}))).toMatchObject({draft: {tools: {daily: true, proactive: false}}});
    await cli(['agents', 'tools', '-'], JSON.stringify({daily: true, apiKey: secret}), 2);
    expect((await client.state()).state.tools).toEqual({daily: true, proactive: false});
    const first = await cli(['agents', 'start']); const firstId = first.agents[0].id;
    await cli(['agents', 'tools', '-'], JSON.stringify({daily: false}), 2);
    expect(await cli(['personal', 'tasks'])).toMatchObject({enabled: true});
    expect(first).toMatchObject({ready: true, draft: null, agents: [{name: 'First assistant', active: true}]});
    await cli(['agents', 'create', 'Second assistant']); await cli(['connections', 'use', connectionId]);
    const second = await cli(['agents', 'start']); expect(second.agents).toHaveLength(2);
    await cli(['agents', 'rename', firstId, 'Renamed assistant']);
    expect(await cli(['agents', 'select', firstId])).toMatchObject({agents: [{id: firstId, name: 'Renamed assistant', active: true}, {active: false}]});
    const a = await cli(['projects', 'open', directory + '/a', connectionId]); const aId = a.active;
    const b = await cli(['projects', 'open', directory + '/b', connectionId]); expect(b.projects).toHaveLength(2);
    expect(await cli(['projects', 'select', aId])).toMatchObject({active: aId, ready: true});
    expect(await cli(['projects', 'connection', aId, connectionId])).toMatchObject({active: aId, ready: true});
    expect((await client.state()).state.ready).toBe(true);
    await cli(['agents', 'create', 'Discard this']);
    await expect(client.call('management', {resource: 'agents', action: 'discard', args: []})).rejects.toThrow('APPLICATION_CONFIRMATION_REQUIRED');
    await cli(['agents', 'discard', '--yes']); expect((await client.state()).state.editing).toBe(false);
    // Malformed input is rejected before contacting the host and never echoes the key.
    await cli(['connections', 'configure', '-'], '{"apiKey":"' + secret, 2);
    expect((await client.state()).state.profiles).toHaveLength(2);
  } finally {await owner.close(); await rm(directory, {recursive: true, force: true});}
}, 30000);

test('personal CLI validates its read-only scope and task offset', () => {
  expect(parseCliArgs(['personal', 'tasks', '20'])).toMatchObject({personalCommand: 'tasks', personalOffset: 20});
  for (const args of [['personal'], ['personal', 'tasks', '-1'], ['personal', 'tasks', '10001'], ['personal', 'tasks', '1.5'], ['personal', 'reminders', '20'], ['personal', 'tasks', '--area', 'code'], ['personal', 'tasks', '--yes']]) expect(() => parseCliArgs(args)).toThrow();
});

test('personal CLI reads the same persisted tasks as the active core and distinguishes a disabled module', async () => {
  const directory = await mkdtemp('/tmp/zhx-personal-cli-'); let stored: string | null = null;
  let active: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  const owner = await startApplicationCoordinator(directory, {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {},
    startHost: async input => active = await startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}})});
  const client = await connectCoordinator(directory);
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'packages/core/src/cli.ts', 'personal', ...args, '--application-directory', directory, '--json'], {stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(code).toBe(0); return parseCliJsonDocument(JSON.parse(stdout)) as any;
  };
  const create = async (daily: boolean) => {
    await client.call('action', {name: 'begin', value: {}});
    await client.call('action', {name: 'provider', value: {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}});
    await client.call('action', {name: 'tools', value: {daily}});
    await client.call('action', {name: 'start', value: {}});
  };
  try {
    await create(true);
    for (let i = 0; i < 23; i++) active!.daily!.createTask({requestId: crypto.randomUUID(), title: `Shared task ${i}`});
    const page = await cli('tasks'); expect(page).toMatchObject({enabled: true, total: 23, nextOffset: 20}); expect(page.tasks).toHaveLength(20);
    const last = await cli('tasks', '20'); expect(last.tasks).toHaveLength(3); expect(last.nextOffset).toBeNull(); expect(last.projectId).toBe(page.projectId);
    expect(await cli('reminders')).toMatchObject({kind: 'application-reminders', enabled: true, reminders: []});
    await create(false);
    const disabled = await cli('tasks'); expect(disabled).toMatchObject({enabled: false, tasks: [], total: 0}); expect(disabled.projectId).not.toBe(page.projectId);
  } finally {await owner.close(); await rm(directory, {recursive: true, force: true});}
}, 20000);
