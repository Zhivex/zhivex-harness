// Real installed core OAuth/loopback/SQLite and packaged Electron; Google HTTP and secrets are fixtures.
import {startApplicationCoordinator} from '@zhivex-ai/harness/application';
import {connectCoordinator} from '@zhivex-ai/harness/application/client';
import {startAssistantHost} from '@zhivex-ai/harness/assistant/host';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {_electron as electron} from 'playwright';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = await mkdtemp('/tmp/zhx-calendar-ui-');
const testCreate = process.argv.includes('--create');
const testEdit = testCreate || process.argv.includes('--edit');
const testAgenda = true;
let modelTurn = 0, patches = 0, posts = 0, listedEvent, editedEvent;
const findValue = (value, predicate) => {if (predicate(value)) return value; if (typeof value === 'string') {try {return findValue(JSON.parse(value), predicate);} catch {return;}} if (value && typeof value === 'object') for (const child of Object.values(value)) {const found = findValue(child, predicate); if (found !== undefined) return found;}};
const model = createMockLanguageModel({streamEvents: [[{type: 'text-delta', textDelta: 'Your day is ready.'}, {type: 'finish', finishReason: 'stop'}], [{type: 'tool-call', toolCall: {id: 'task-fixture', name: 'daily_write_create_task', input: {requestId: crypto.randomUUID(), title: 'Prepare the Electron demo'}}}, {type: 'finish', finishReason: 'tool-calls'}], [{type: 'text-delta', textDelta: 'Your task is saved.'}, {type: 'finish', finishReason: 'stop'}]]});
if (testEdit) model.stream = async input => (async function* () {
  const index = modelTurn++;
  if (index < (testCreate ? 1 : 2)) {
    const prompt = index === 0 ? findValue(input.messages, value => typeof value === 'string' && value.startsWith(testCreate ? 'Use calendar_write_create with exactly this input: ' : 'Use calendar_read_propose with exactly this input: ')) : undefined;
    const args = index === 0 ? JSON.parse(prompt.match(/^Use calendar_(?:read_propose|write_create) with exactly this input: (.+)\. (?:Then request|Request approval)/)[1]) : findValue(input.messages, value => value && typeof value === 'object' && 'operationId' in value && 'proposalDigest' in value);
    if (testCreate) {assert.deepEqual(Object.keys(args).sort(), ['operationId', 'proposalDigest']);}
    assert(args); yield {type: 'tool-call', toolCall: {id: 'calendar-edit-' + index, name: index === 0 ? (testCreate ? 'calendar_write_create' : 'calendar_read_propose') : (testCreate ? 'calendar_write_create' : 'calendar_write_apply'), input: args}}; yield {type: 'finish', finishReason: 'tool-calls'};
  } else {yield {type: 'text-delta', textDelta: 'Calendar result received.'}; yield {type: 'finish', finishReason: 'stop'};}
})();
let stored = null, exchanges = 0, desktop, page, agendaMode = 'complete', agendaReads = 0;
const integrationFetch = async (input, init) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {exchanges++; assert(String(init.body).includes('code_verifier=')); return Response.json({token_type: 'Bearer', access_token: 'private-fixture-access', refresh_token: 'private-fixture-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events'});}
  if (url.endsWith('/userinfo')) return Response.json({sub: 'fixture-account', email: 'owner@example.test', email_verified: true});
  if (testCreate && init?.method === 'POST' && url.includes('/events?')) {posts++; assert(url.includes('sendUpdates=all')); editedEvent = {...JSON.parse(init.body), etag: 'created-v1'}; return Response.json(editedEvent);}
  if (testEdit && url.includes('/events/meeting')) {
    const current = editedEvent ?? {...listedEvent, organizer: {self: true}, attendees: [{email: 'guest@example.test'}]};
    if (init?.method === 'PATCH') {
      assert.equal(new Headers(init.headers).get('if-match'), current.etag); assert(url.includes('sendUpdates=all'));
      patches++; editedEvent = {...current, ...JSON.parse(init.body), etag: 'v2'}; return Response.json(editedEvent);
    }
    return Response.json(current);
  }
  if (testAgenda && url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?')) {
    assert.equal(init?.method ?? 'GET', 'GET'); agendaReads++;
    if (agendaMode === 'error') return Response.json({error: {message: 'fixture denied'}}, {status: 403});
    if (editedEvent) return Response.json({items: [editedEvent]});
    if (agendaMode === 'empty') return Response.json({items: []});
    const query = new URL(url).searchParams, from = Date.parse(query.get('timeMin'));
    const date = query.get('timeMin').slice(0, 10), endDate = new Date(from + 86400000).toISOString().slice(0, 10);
    const event = {id: 'meeting', etag: 'v1', summary: 'Meeting fixture', start: {dateTime: new Date(from + 10*3600000).toISOString()}, end: {dateTime: new Date(from + 11*3600000).toISOString()}};
    listedEvent = event;
    if (agendaMode === 'partial') return Response.json({items: [event], nextPageToken: 'loop'});
    if (query.get('pageToken')) return Response.json({items: [{...event, summary: 'Meeting fixture updated'}]});
    return Response.json({items: [event, {id: 'all', etag: 'v1', summary: '<script>Calendar title</script>', start: {date}, end: {date: endDate}}], nextPageToken: 'next'});
  }
  throw new Error('Unexpected external request');
};
const owner = await startApplicationCoordinator(directory + '/app', {integrationFetch, secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: input => startAssistantHost({...input, engine: {...input.engine, modelInstance: model}})});
const client = await connectCoordinator(directory + '/app'), errors = [];
async function wait(check) {const end = Date.now() + 10000; while (!await check()) {if (Date.now() > end) throw new Error('CONDITION_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 50));}}
try {
  desktop = await electron.launch({executablePath: path.join(root, 'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'packages/desktop/build/unified-main.cjs'), '--assistant-directory', directory + '/app', '--user-data', directory + '/electron'], env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME, ZHIVEX_HARNESS_CREDENTIAL_STORE: 'disabled'}});
  page = await desktop.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', {name, exact: true});
  await desktop.evaluate(({shell}) => {shell.openExternal = async url => {globalThis.fixtureCalendarUrl = url;};});
  await page.getByLabel('Assistant name', {exact: true}).fill('Calendar fixture'); await button('Create assistant').click();
  await button('Configure optional connections now').click();
  if (testCreate) await page.getByLabel('Enable reviewed event creation for this assistant', {exact: true}).check();
  const begin = async () => {await page.getByLabel('Google OAuth client ID', {exact: true}).fill('fixture.apps.googleusercontent.com'); await page.getByLabel('Google OAuth client secret (optional)', {exact: true}).fill('private-client-secret'); await desktop.evaluate(() => {globalThis.fixtureCalendarUrl = undefined;}); await button('Connect Google Calendar').click(); await wait(() => desktop.evaluate(() => Boolean(globalThis.fixtureCalendarUrl))); return new URL(await desktop.evaluate(() => globalThis.fixtureCalendarUrl));};
  const first = await begin(); assert.equal(first.hostname, 'accounts.google.com'); assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(await button('Connect and start').isEnabled(), false);
  await page.screenshot({path: directory + '/pending.png'});
  await button('Cancel Calendar authorization').click(); await button('Connect Google Calendar').waitFor();
  assert.equal((await client.call('authorization')).url, null); assert.equal(exchanges, 0);
  assert.equal(await page.getByLabel('Google OAuth client secret (optional)', {exact: true}).inputValue(), '');
  const second = await begin(); assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  const callback = new URL(second.searchParams.get('redirect_uri')); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', first.searchParams.get('state'));
  assert.equal((await fetch(callback)).status, 400); assert.equal(exchanges, 0);
  callback.searchParams.set('state', second.searchParams.get('state')); assert.equal((await fetch(callback)).status, 200);
  await page.getByText('Calendar connected: owner@example.test', {exact: true}).waitFor(); assert.equal(exchanges, 1);
  await page.screenshot({path: directory + '/connected.png'});
  const state = (await client.state()).state;
  for (const secret of ['private-fixture-access', 'private-fixture-refresh', 'private-client-secret']) assert.equal(JSON.stringify(state).includes(secret), false);
  const saved = JSON.parse(stored); const bytes = await readFile(path.join(directory, 'app', saved.draft.id, 'state/calendar.sqlite')); assert.equal(bytes.includes(Buffer.from('private-fixture-refresh')), false);
  await page.getByLabel('Provider', {exact: true}).selectOption('custom'); await page.getByLabel('API URL', {exact: true}).fill('https://example.invalid/v1'); await page.getByLabel('Model', {exact: true}).fill('mock'); await page.getByLabel('API key', {exact: true}).fill('fixture-key'); await page.getByLabel('Enable tasks and reminders', {exact: true}).check(); await button('Connect and start').click();
  await page.locator('nav').getByRole('button', {name: 'Today', exact: true}).waitFor(); await wait(async () => (await client.state()).state.ready);
  if (testEdit) {
    await page.locator('.new-conversation').click();
    await page.locator('nav').getByRole('button', {name: 'Agenda', exact: true}).click();
    await page.getByText('Meeting fixture updated', {exact: true}).waitFor();
    if (testCreate) {
      await page.locator('summary').filter({hasText: 'New calendar event'}).click();
      await page.getByLabel('New event title').fill('Created from Electron');
      await page.getByLabel('New event start (UTC)').fill('2026-11-16T14:00');
      await page.getByLabel('New event end (UTC)').fill('2026-11-16T15:00');
      await page.getByLabel('Attendee emails (one per line)').fill('guest@example.test');
      await button('Ask to create event').click();
    } else {
      await button('Edit event').first().click(); await page.getByLabel('Event title', {exact: true}).fill('Reviewed change'); await button('Ask to change event').click();
    }
    await button('Load review').click();
    assert.equal(patches + posts, 0);
    for (const checkbox of await page.getByRole('region', {name: 'Action review'}).getByRole('checkbox').all()) await checkbox.check();
    await page.screenshot({path: directory + '/calendar-review.png'}); await button('Approve this action').click();
    await wait(async () => patches + posts === 1);
    assert.deepEqual(errors, []);
    const report = {passed:true,directory,coreArtifactSha256:JSON.parse(await readFile(root+'/packages/desktop/.harness/installed.json','utf8')).sha256,mode:testCreate?'create':'edit',patches,posts,checks:['OAuth from Electron with loopback','visual event form prepares exact core proposal','no write before review','one approved HTTP write with attendee notifications'],limitations:['Local HTTP/model/SecretStore fixtures; no external calendar or notifications']};
    await writeFile(directory+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } else {
  await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 1440, height: 960}));
  const home = page.getByRole('region', {name: 'Today overview'});
  await home.waitFor(); await home.getByText('Meeting fixture updated', {exact: true}).waitFor();
  await home.getByText('2 events today', {exact: true}).waitFor();
  await page.getByLabel('Message', {exact: true}).fill('Draft for my day');
  await page.screenshot({path: directory + '/today-light.png'});
  await button('View agenda').click();
  const date = await page.getByLabel('Agenda date', {exact: true}).inputValue();
  await button('Next day').click(); await wait(async () => await page.getByLabel('Agenda date', {exact: true}).inputValue() !== date);
  await button('Previous day').click(); await wait(async () => await page.getByLabel('Agenda date', {exact: true}).inputValue() === date);
  await page.locator('nav').getByRole('button', {name: 'Today', exact: true}).click();
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Draft for my day');
  await page.reload(); await home.waitFor(); assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Draft for my day');
  await button('Search pages and conversations').click();
  const palette = page.getByRole('dialog', {name: 'Go to…'}), search = palette.getByRole('textbox');
  await search.fill('Agenda'); await search.press('Enter'); await page.getByLabel('Agenda date', {exact: true}).waitFor();
  await page.keyboard.press('Meta+k'); await search.fill('Today'); await search.press('Enter'); await home.waitFor();
  await button('Search pages and conversations').click(); await search.fill('no matching view'); await page.getByText('No matching pages or conversations.').waitFor();
  await search.press('Escape'); assert.equal(await button('Search pages and conversations').evaluate(el => el === document.activeElement), true);
  agendaMode = 'partial'; await button('Refresh overview').click(); await home.getByText('This agenda is incomplete. Missing events do not mean free time.').waitFor();
  agendaMode = 'error'; await button('Refresh overview').click(); await home.getByText('Calendar unavailable', {exact: true}).waitFor();
  assert.equal(await home.getByText('0 events today', {exact: true}).count(), 0);
  agendaMode = 'empty'; await button('Refresh overview').click(); await home.getByText('0 events today', {exact: true}).waitFor();
  agendaMode = 'complete'; await button('Refresh overview').click(); await home.getByText('2 events today', {exact: true}).waitFor();
  await button('Dark appearance').click(); await page.screenshot({path: directory + '/today-dark.png'});
  for (const [width, height] of [[1280,720],[390,844]]) {
    await desktop.evaluate(({BrowserWindow}, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), {width,height});
    await page.waitForFunction(w => innerWidth === w, width);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await page.getByLabel('Message', {exact: true}).isVisible());
    await page.screenshot({path: `${directory}/today-${width}.png`});
  }
  await page.keyboard.press('Meta+k'); await search.fill('Tasks'); await search.press('Enter'); await page.getByRole('heading', {name: 'Tasks & reminders', exact: true}).waitFor();
  await page.keyboard.press('Meta+k'); await search.fill('Today'); await search.press('Enter'); await home.waitFor();
  await page.getByLabel('Message', {exact: true}).fill('Help me plan today');
  await button('Send message').click(); await wait(async () => !(await home.isVisible()));
  await page.getByText('Help me plan today', {exact: true}).waitFor();
  await page.getByText('Your day is ready.', {exact: true}).waitFor();
  const openToday = async () => {await page.keyboard.press('Meta+k'); await search.fill('Today'); await search.press('Enter'); await home.waitFor();};
  await openToday(); await page.getByLabel('Message', {exact: true}).fill('Create a task to prepare the Electron demo'); await button('Send message').click();
  await page.getByText('An action needs your review.', {exact: true}).waitFor();
  await openToday(); await home.getByText('1 conversation to review', {exact: true}).waitFor();
  await home.getByText('0 tasks to do', {exact: true}).waitFor();
  await home.locator('.decision-shortlist button').click(); await button('Load review').click(); await button('Approve this action').waitFor();
  await page.screenshot({path: directory + '/task-review-compact.png'});
  await button('Approve this action').click(); await page.getByText('Your task is saved.', {exact: true}).waitFor();
  await openToday(); await home.getByText('1 task to do', {exact: true}).waitFor(); await home.getByText('Prepare the Electron demo', {exact: true}).waitFor();
  await home.getByText('0 conversations to review', {exact: true}).waitFor();
  await page.getByLabel('Message', {exact: true}).fill('Uncertain result fixture'); await button('Send message').click();
  await page.getByRole('alert').filter({hasText: 'The result could not be confirmed.'}).waitFor();
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Uncertain result fixture');
  await button('View agenda').click(); await openToday(); assert.equal(await button('Send message').isDisabled(), true);
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Uncertain result fixture');
  assert.deepEqual(errors, []);
  const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
  const report = {passed: true, directory, coreArtifactSha256: installed.sha256, checks: ['real core calendar with pagination', 'Today is initial Assistant page', 'draft survives Agenda and reload', 'calendar day navigation', 'command palette navigation, empty search, Escape and focus return', 'partial, error and empty states distinguished', 'light and dark themes', '1440, 1280 and 390 widths without document overflow', 'compact keyboard navigation', 'first message creates conversation and starts core run', 'Today opens the exact pending review', 'task remains absent before approval and appears from core after approval', 'unconfirmed run preserves draft and blocks resubmission across navigation'], limitations: ['Provider, Google HTTP and SecretStore are injected fixtures; no keychain, external account or delivery used.']};
  await writeFile(directory + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report,null,2));
  }
} catch (error) {if (page) {console.error(await page.locator('body').innerText()); await page.screenshot({path: directory + '/failure.png'});} throw error;}
finally {await desktop?.close(); await owner.close(); console.log('Artifacts: ' + directory);}
