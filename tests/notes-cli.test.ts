import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {parseCliArgs} from '../packages/core/src/cli/arguments.js';
import {parseCliJsonDocument} from '../packages/core/src/client/json-contracts.js';

test('notes CLI validates query, identity and pagination before discovery', () => {
  expect(parseCliArgs(['personal', 'notes', '20'])).toMatchObject({personalCommand: 'notes', personalOffset: 20});
  expect(parseCliArgs(['personal', 'search-notes', ' meeting ', '40'])).toMatchObject({personalQuery: 'meeting', personalOffset: 40});
  const id = randomUUID(); expect(parseCliArgs(['personal', 'note', id])).toMatchObject({personalNoteId: id});
  for (const args of [['notes','-1'], ['notes','10001'], ['notes','1','2'], ['search-notes'], ['search-notes',' '], ['search-notes','x'.repeat(201)], ['note'], ['note','bad'], ['note',id,'0'], ['notes','--area','code'], ['notes','--jsonl'], ['notes','--yes']]) expect(() => parseCliArgs(['personal', ...args])).toThrow();
});

test('notes CLI reads the shared scoped state without creating or deleting notes', async () => {
  const root = await mkdtemp('/tmp/zhx-notes-cli-'); let stored: string | null = null;
  let host: Awaited<ReturnType<typeof startAssistantHost>>;
  const owner = await startApplicationCoordinator(root, {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: async input => host = await startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}})});
  const client = await connectCoordinator(root);
  const cli = async (args: string[], expected = 0) => {
    const child = Bun.spawn([...(process.env.ZHX_CLI_TEST_ENTRY ? ['node', process.env.ZHX_CLI_TEST_ENTRY] : [process.execPath, '--no-env-file', 'packages/core/src/cli.ts']), 'personal', ...args, '--application-directory', root, '--json'], {stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(expected);
    const result = JSON.parse(code === 0 ? stdout : stderr); if (!code) parseCliJsonDocument(result); return result;
  };
  const create = async (daily: boolean) => {
    await client.call('action', {name: 'begin', value: {}});
    await client.call('action', {name: 'provider', value: {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}});
    await client.call('action', {name: 'tools', value: {daily}});
    await client.call('action', {name: 'start', value: {}});
  };
  try {
    await create(true);
    const ids = Array.from({length: 23}, () => randomUUID());
    for (const [i, requestId] of ids.entries()) host!.daily!.saveNote({requestId, title: `Note ${i}`, text: `Shared body ${i}`});
    const listed = await cli(['notes']); expect(listed.total).toBe(23); expect(listed.notes).toHaveLength(20); expect(listed.nextOffset).toBe(20);
    expect((await cli(['notes', '20'])).notes).toHaveLength(3);
    const found = await cli(['search-notes', 'body 22']); expect(found.total).toBe(1); expect(found.notes[0].id).toBe(ids[22]);
    const read = await cli(['note', ids[0]!]); expect(read.note.body).toBe('Shared body 0');
    expect(await client.call('notes', {projectId: listed.projectId, noteId: ids[0]})).toMatchObject({total: read.total, note: read.note});
    await cli(['note', randomUUID()], 1);
    expect(host!.daily!.listNotes({}).total).toBe(23);
    await create(false);
    expect(await cli(['notes'])).toMatchObject({enabled: false, total: 0, notes: []});
    await expect(client.call('notes', {projectId: listed.projectId})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
  } finally {await owner.close(); await rm(root, {recursive: true, force: true});}
}, 30000);
