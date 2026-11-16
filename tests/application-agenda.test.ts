import {test, expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {connectApplication} from '../packages/core/src/application/client.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import type {AgendaSource} from '../packages/core/src/application/assistant/automation/summary.js';
const timed = {id: 'one', summary: 'Meeting', start: {dateTime: '2026-03-08T14:00:00Z'}, end: {dateTime: '2026-03-08T15:00:00Z'}};
async function fixture() {
  const directory = await mkdtemp('/tmp/zhx-agenda-'); let stored: string | null = null, available = true;
  let prepare: ((input: unknown) => {operationId: string; proposalDigest: string}) | undefined;
  let list: AgendaSource['list'] = async () => ({events: [], nextPageToken: null, complete: true});
  const owner = await startApplicationCoordinator(directory, {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: async input => {
    const host = await startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}});
    return {...host, get prepareCalendarCreation() {return prepare;}, get agendaSource() {return available ? {binding: 'fixture', calendarId: 'primary', list: (...args: Parameters<AgendaSource['list']>) => list(...args)} : undefined;}};
  }});
  const client = await connectCoordinator(directory);
  for (const [name, value] of [['begin', {}], ['provider', {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}], ['start', {}]] as const) await client.call('action', {name, value});
  const projectId = (await connectApplication((await client.state()).credentialsPath!)).projectId;
  const input = {projectId, date: '2026-03-08', timeZone: 'America/New_York'};
  return {client, input, owner, setPrepare(value: typeof prepare) {prepare = value;}, setList(fn: AgendaSource['list']) {list = fn;}, unavailable() {available = false;}, async close() {await owner.close(); await rm(directory, {recursive: true, force: true});}};
}
test('agenda distinguishes unavailable/empty/incomplete, deduplicates pages and respects DST day bounds', async () => {
  const f = await fixture();
  try {
    expect(await f.client.call('agenda', f.input)).toMatchObject({connected: true, complete: true, events: []});
    let calls = 0;
    f.setList(async input => {
      calls++; expect(Date.parse(input.timeMax) - Date.parse(input.timeMin)).toBe(23 * 3600000);
      return input.pageToken ? {events: [{...timed, summary: 'Updated'}], nextPageToken: null, complete: true} : {events: [timed, {id: 'all', summary: 'All day', start: {date: '2026-03-08'}, end: {date: '2026-03-09'}}], nextPageToken: 'next', complete: false};
    });
    expect(await f.client.call('agenda', f.input)).toMatchObject({complete: true, events: [{id: 'all'}, {id: 'one', summary: 'Updated'}]}); expect(calls).toBe(2);
    calls = 0; f.setList(async () => {calls++; return {events: [timed], nextPageToken: 'loop', complete: false};});
    expect(await f.client.call('agenda', f.input)).toMatchObject({complete: false, events: [timed]}); expect(calls).toBe(2);
    f.setList(async () => {throw new Error('CALENDAR_REAUTHORIZE');});
    await expect(f.client.call('agenda', f.input)).rejects.toThrow('CALENDAR_REAUTHORIZE');
    await expect(f.client.call('agenda', {...f.input, projectId: 'old'})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
    await expect(f.client.call('agenda', {...f.input, date: '2026-02-30'})).rejects.toThrow();
    f.unavailable(); expect(await f.client.call('agenda', f.input)).toMatchObject({connected: false, events: []});
  } finally {await f.close();}
});
test('slow agenda does not block coordinator health and shutdown cancels even an unresponsive source', async () => {
  const f = await fixture(); let entered!: () => void; const started = new Promise<void>(resolve => {entered = resolve;});
  try {
    f.setList(async () => {entered(); return new Promise(() => {});});
    const pending = f.client.call('agenda', f.input).then(() => 'unexpected-success', error => error.message);
    await started; expect((await f.client.state()).state.ready).toBe(true);
    await f.owner.close(); expect(await pending).toBe('AGENDA_READ_CANCELLED');
  } finally {await f.close();}
}, 10000);
test('an agenda response from the previous agent is rejected after selection changes', async () => {
  const f = await fixture(); let entered!: () => void, finish!: (value: Awaited<ReturnType<AgendaSource['list']>>) => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  try {
    f.setList(async () => {entered(); return new Promise(resolve => {finish = resolve;});});
    const pending = f.client.call('agenda', f.input).then(() => 'unexpected-success', error => error.message);
    await started;
    for (const [name, value] of [['begin', {}], ['provider', {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}], ['start', {}]] as const) await f.client.call('action', {name, value});
    finish({events: [timed], complete: true, nextPageToken: null});
    expect(await pending).toBe('APPLICATION_SCOPE_CHANGED');
  } finally {await f.close();}
});

test('calendar creation preparation is scoped, capability-gated and returns only the reference', async () => {
  const f = await fixture();
  const event = {requestId: randomUUID(), summary: 'Private proposal', start: '2026-11-14T12:00:00Z', end: '2026-11-14T13:00:00Z', attendees: ['guest@example.test']};
  try {
    await expect(f.client.call('calendar-create-proposal', {projectId: f.input.projectId, event})).rejects.toThrow('CALENDAR_CREATION_DISABLED');
    let calls = 0;
    f.setPrepare(raw => {calls++; expect(raw).toEqual(event); return {operationId: event.requestId, proposalDigest: 'sha256:' + 'a'.repeat(64)};});
    await expect(f.client.call('calendar-create-proposal', {projectId: 'other', event})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
    await expect(f.client.call('calendar-create-proposal', {projectId: f.input.projectId, event, apply: true})).rejects.toThrow();
    expect(calls).toBe(0);
    const result = await f.client.call('calendar-create-proposal', {projectId: f.input.projectId, event});
    expect(Object.keys(result as object).sort()).toEqual(['operationId', 'proposalDigest']); expect(calls).toBe(1);
  } finally {await f.close();}
});
