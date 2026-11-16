import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startManagedAssistant} from '../packages/core/src/application/assistant/managed/setup.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {readNotes} from '../packages/core/src/application/notes.js';
import {readPersonalState} from '../packages/core/src/application/personal-state.js';
import {connectApplication} from '../packages/core/src/application/client.js';

test('personal projection paginates persisted tasks and refuses a stale agent binding', async () => {
  const root = await mkdtemp('/tmp/zhx-personal-'); let stored: string | null = null;
  const options = {secrets: {async read() {return stored;}, async write(value: string) {stored = value;}}, validateProvider: async () => {}, startHost: (input: Parameters<typeof startAssistantHost>[0]) => startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}})};
  let manager = await startManagedAssistant(root, options);
  const create = async (daily: boolean) => {await manager.action('begin', {}); await manager.action('provider', {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}); await manager.action('tools', {daily}); await manager.action('start', {}); return (await connectApplication(manager.currentHost()!.credentialsPath)).projectId;};
  try {
    const projectId = await create(true); const first = manager.state().profiles[0]!.id;
    for (let i = 0; i < 23; i++) manager.currentHost()!.daily!.createTask({requestId: randomUUID(), title: `Task ${i}`});
    const firstPage = await readPersonalState(manager, {projectId}); expect(firstPage.tasks).toHaveLength(20); expect(firstPage.total).toBe(23); expect(firstPage.nextOffset).toBe(20);
    const lastPage = await readPersonalState(manager, {projectId, offset: 20}); expect(lastPage.tasks).toHaveLength(3); expect(lastPage.nextOffset).toBeNull();
    const noteIds = Array.from({length: 23}, () => randomUUID());
    for (const [i, requestId] of noteIds.entries()) manager.currentHost()!.daily!.saveNote({requestId, title: `Note ${i}`, text: `Stored content ${i} <script>not executable</script>`});
    const notes = await readNotes(manager, {projectId}); expect(notes.notes).toHaveLength(20); expect(notes.total).toBe(23); expect(notes.nextOffset).toBe(20);
    expect((await readNotes(manager, {projectId, offset: 20})).notes).toHaveLength(3);
    const selected = await readNotes(manager, {projectId, noteId: noteIds[0]}); expect(selected.note?.body).toBe('Stored content 0 <script>not executable</script>');
    expect((await readNotes(manager, {projectId, query: 'content 22'})).total).toBe(1);
    expect((await readNotes(manager, {projectId, query: 'missing'})).total).toBe(0);
    await expect(readNotes(manager, {projectId, noteId: randomUUID()})).rejects.toThrow('NOTE_NOT_FOUND');
    await expect(readNotes(manager, {projectId, action: 'delete'})).rejects.toThrow();
    await expect(readNotes(manager, {projectId, offset: -1})).rejects.toThrow();
    const next = await create(false);
    expect(await readNotes(manager, {projectId: next})).toMatchObject({enabled: false, notes: []});
    await expect(readNotes(manager, {projectId})).rejects.toThrow('APPLICATION_SCOPE_CHANGED'); expect(await readPersonalState(manager, {projectId: next})).toMatchObject({enabled: false, tasks: [], reminders: []});
    await expect(readPersonalState(manager, {projectId})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
    await manager.action('select', {id: first}); await manager.close(); manager = await startManagedAssistant(root, options);
    const restored = (await connectApplication(manager.currentHost()!.credentialsPath)).projectId;
    expect((await readNotes(manager, {projectId: restored, noteId: noteIds[0]})).note?.body).toBe('Stored content 0 <script>not executable</script>');
    manager.currentHost()!.daily!.deleteNote({requestId: randomUUID(), noteId: noteIds[0]});
    await expect(readNotes(manager, {projectId: restored, noteId: noteIds[0]})).rejects.toThrow('NOTE_NOT_FOUND');
    expect(await readPersonalState(manager, {projectId: restored})).toMatchObject({enabled: true, total: 23});
    await expect(readPersonalState(manager, {projectId: restored, offset: -1})).rejects.toThrow();
  } finally {await manager.close(); await rm(root, {recursive: true, force: true});}
});
