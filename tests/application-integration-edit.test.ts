import {test, expect} from 'bun:test';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {GENERAL_ASSISTANT_PROFILE} from '../packages/core/src/engine/index.js';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startManagedAssistant} from '../packages/core/src/application/assistant/managed/setup.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {connectApplication} from '../packages/core/src/application/client.js';
import {readPersonalState} from '../packages/core/src/application/personal-state.js';

test('editing an existing agent pauses readers, survives restart, commits tools and preserves identity and sessions', async () => {
 const directory = await mkdtemp('/tmp/zhx-edit-integrations-'); let stored: string | null = null;
 const options = {secrets: {async read() {return stored;}, async write(value: string) {stored = value;}}, validateProvider: async () => {}, startHost: (input: Parameters<typeof startAssistantHost>[0]) => startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}})};
 let manager = await startManagedAssistant(directory, options);
 try {
  await manager.action('begin', {name: 'Personal'}); await manager.action('provider', {baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: 'fixture'});
  await manager.action('tools', {daily: true}); await manager.action('start', {});
  const id = manager.state().profiles[0]!.id;
  let client = await connectApplication(manager.currentHost()!.credentialsPath); const projectId = client.projectId;
  await client.command({method: 'session.create', idempotencyKey: 'new', title: 'Preserved conversation'});
  await expect(manager.action('edit-integrations', {id: 'foreign'})).rejects.toThrow('SETUP_SELECT_AGENT_FIRST');
  await manager.action('edit-integrations', {id});
  expect(manager.currentHost()).toBeUndefined(); expect(manager.state()).toMatchObject({editingExisting: true, editing: true, ready: false});
  await expect(client.command({method: 'session.list'})).rejects.toThrow();
  await manager.action('tools', {daily: true, proactive: true});
  await manager.close(); manager = await startManagedAssistant(directory, options);
  expect(manager.currentHost()).toBeUndefined();
  await manager.action('retry', {}); expect(manager.currentHost()).toBeUndefined();
  await manager.action('start', {});
  expect(manager.state().profiles).toHaveLength(1); expect(manager.state().profiles[0]!.id).toBe(id);
  client = await connectApplication(manager.currentHost()!.credentialsPath); expect(client.projectId).toBe(projectId);
  expect(await client.command({method: 'session.list'})).toMatchObject({ok: true, data: {sessions: [{title: 'Preserved conversation'}]}});
  expect((await readPersonalState(manager, {projectId})).proactive?.enabled).toBe(true);
  await expect(readPersonalState(manager, {projectId: 'foreign'})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
  await manager.action('edit-integrations', {id}); await manager.action('tools', {daily: false}); await manager.action('discard', {});
  expect(manager.state().editing).toBe(false); expect(manager.currentHost()).toBeDefined();
  expect((await readPersonalState(manager, {projectId})).proactive?.enabled).toBe(true);
 } finally {await manager.close(); await rm(directory, {recursive: true, force: true});}
});

test('explicit binding transition refuses a live owner and requires the exact prior manifest', async () => {
 const directory = await mkdtemp('/tmp/zhx-binding-transition-');
 const options = {directory, ownerId: 'owner', engine: {modelInstance: createMockLanguageModel(), agentProfile: {...GENERAL_ASSISTANT_PROFILE, toolNames: []}}};
 let host = await startAssistantHost(options);
 const prior = await readFile(directory + '/state/host.json', 'utf8');
 const next = {...options, engine: {...options.engine, agentProfile: {...options.engine.agentProfile, instructions: 'Explicitly changed instructions'}}};
 try {
  await expect(startAssistantHost({...next, rebindFrom: prior})).rejects.toThrow('ASSISTANT_REBIND_OWNER_ALIVE');
  expect(await readFile(directory + '/state/host.json', 'utf8')).toBe(prior);
  await host.close();
  await expect(startAssistantHost(next)).rejects.toThrow('ASSISTANT_HOST_BINDING_MISMATCH');
  await expect(startAssistantHost({...next, rebindFrom: 'forged'})).rejects.toThrow('ASSISTANT_HOST_BINDING_MISMATCH');
  host = await startAssistantHost({...next, rebindFrom: prior});
  expect(await readFile(directory + '/state/host.json', 'utf8')).not.toBe(prior);
 } finally {await host.close(); await rm(directory, {recursive: true, force: true});}
});
