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
const testAgenda = testEdit || process.argv.includes('--agenda');
let modelTurn = 0, patches = 0, posts = 0, listedEvent, editedEvent;
const findValue = (value, predicate) => {if (predicate(value)) return value; if (typeof value === 'string') {try {return findValue(JSON.parse(value), predicate);} catch {return;}} if (value && typeof value === 'object') for (const child of Object.values(value)) {const found = findValue(child, predicate); if (found !== undefined) return found;}};
const model = createMockLanguageModel();
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
  desktop = await electron.launch({executablePath: path.join(root, 'packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness'), args: ['--assistant-directory', directory + '/app', '--user-data', directory + '/electron'], env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME}});
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
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
  await page.getByLabel('Provider', {exact: true}).selectOption('custom'); await page.getByLabel('API URL', {exact: true}).fill('https://example.invalid/v1'); await page.getByLabel('Model', {exact: true}).fill('mock'); await page.getByLabel('API key', {exact: true}).fill('fixture-key'); await button('Connect and start').click();
  await button('New conversation').waitFor(); await wait(async () => (await client.state()).state.ready);
  if (testAgenda) {
    if (testEdit) await page.getByRole('button', {name: 'New conversation', exact: true}).first().click();
    await button('Agenda').click(); await page.getByText('Meeting fixture updated', {exact: true}).waitFor();
    await page.getByText('<script>Calendar title</script>', {exact: true}).waitFor();
    assert.equal(await page.locator('.personal-list li').count(), 2);
    await page.screenshot({path: directory + '/agenda.png'});
    await button('Dark appearance').click(); await page.screenshot({path: directory + '/agenda-dark.png'});
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 390, height: 900}));
    await page.waitForFunction(() => innerWidth <= 390); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: directory + '/agenda-compact.png'});
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 1440, height: 960}));
    await page.waitForFunction(() => innerWidth >= 1400); await button('Light appearance').click();
    agendaMode = 'partial'; await button('Refresh agenda').click(); await page.getByRole('alert').filter({hasText: 'This agenda is incomplete'}).waitFor();
    await page.screenshot({path: directory + '/agenda-partial.png'});
    agendaMode = 'error'; await button('Refresh agenda').click(); await page.getByRole('alert').filter({hasText: 'Could not read this calendar'}).waitFor();
    assert.equal(await page.getByText('No events for this date.', {exact: true}).count(), 0);
    agendaMode = 'empty'; await button('Refresh agenda').click(); await page.getByText('No events for this date.', {exact: true}).waitFor();
    assert(agendaReads >= 6);
    if (testEdit) {
      agendaMode = 'complete'; await button('Refresh agenda').click();
      if (testCreate) {
        await page.getByText('New calendar event', {exact: true}).click();
        await page.getByLabel('New event title', {exact: true}).fill('Reviewed calendar creation');
        await page.getByLabel('New event start (UTC)', {exact: true}).fill('2026-11-14T12:00');
        await page.getByLabel('New event end (UTC)', {exact: true}).fill('2026-11-14T13:00');
        await page.getByLabel('Attendee emails (one per line)', {exact: true}).fill('guest@example.test');
        await button('Ask to create event').click();
      } else {
      await button('Edit event').click();
      await page.getByLabel('Event title', {exact: true}).fill('Reviewed calendar change');
      await page.getByLabel('Event start (UTC)', {exact: true}).fill('2026-11-14T12:00');
      await page.getByLabel('Event end (UTC)', {exact: true}).fill('2026-11-14T13:00');
      await button('Ask to change event').click();
      }
      await button('Load review').click();
      await button('Approve this action').waitFor(); assert.equal(patches, 0); assert.equal(posts, 0);
      assert((await page.getByRole('region', {name: 'Action review'}).innerText()).includes('guest@example.test'));
      const calendarReview = page.getByRole('region', {name: testCreate ? 'Calendar creation review' : 'Calendar change review', exact: true});
      if (!testCreate) await calendarReview.getByRole('region', {name: 'Before', exact: true}).getByText('Meeting fixture', {exact: true}).waitFor();
      await calendarReview.getByRole('region', {name: testCreate ? 'New event' : 'After', exact: true}).getByText(testCreate ? 'Reviewed calendar creation' : 'Reviewed calendar change', {exact: true}).waitFor();
      await calendarReview.getByText('guest@example.test', {exact: true}).waitFor();
      assert.equal(await page.locator('.review-item details').getAttribute('open'), null);

      await page.screenshot({path: directory + '/event-review.png'});
      await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 390, height: 900}));
      await page.waitForFunction(() => innerWidth <= 390); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path: directory + '/event-review-compact.png'});
      await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 1440, height: 960}));
      await page.waitForFunction(() => innerWidth >= 1400);

      await button('Approve this action').click(); await wait(() => testCreate ? posts === 1 : patches === 1);
      await page.getByText('Calendar result received.', {exact: true}).waitFor();
      await button('Agenda').click(); await page.getByText(testCreate ? 'Reviewed calendar creation' : 'Reviewed calendar change', {exact: true}).waitFor();
      assert.equal(testCreate ? posts : patches, 1); assert.equal(editedEvent.start.dateTime, '2026-11-14T12:00:00.000Z');
      await page.screenshot({path: directory + '/event-changed.png'});
      if (testCreate) {
        await page.getByText('New calendar event', {exact: true}).click();
        assert.equal(await page.getByLabel('New event title', {exact: true}).inputValue(), 'Reviewed calendar creation');
        modelTurn = 0; await button('Ask to create event').click(); await button('Load review').click();
        await page.getByRole('alert').filter({hasText: 'This preview is incomplete'}).waitFor();
        assert.equal(await button('Approve this action').isEnabled(), false); assert.equal(posts, 1);
        await button('Reject').click();
      }

    }

  }
  assert.deepEqual(errors, []);
  const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
  const report = {passed: true, testAgenda, testEdit, testCreate, patches, posts, directory, coreArtifactSha256: installed.sha256, checks: [...(testCreate ? ['creation explicitly enabled during setup', 'no POST before approval', 'one POST after approval with exact recipients', 'persisted requestId prevents duplicate creation when returning to the form'] : []), ...(testEdit && !testCreate ? ['event change proposed from agenda', 'attendees shown in trusted review', 'structured before and after review with compact layout', 'no PATCH before approval', 'one conditional PATCH and refreshed event after approval'] : []), ...(testAgenda ? ['paginated agenda deduplicates events', 'titles rendered as text', 'incomplete agenda labeled', 'provider failure not shown as empty', 'complete empty agenda distinguished'] : []), 'only current Google authorization opened', 'PKCE enabled', 'startup disabled during authorization', 'cancel clears authorization', 'stale callback state rejected', 'successful callback reflected without reopening settings', 'tokens excluded from public state', 'refresh token encrypted at rest', 'agent starts with Calendar'], limitations: ['Google HTTP, secret storage and browser opening are fixtures. No live Google account accessed.']};
  await writeFile(directory + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {if (page) {console.error(await page.locator('body').innerText()); await page.screenshot({path: directory + '/failure.png'});} throw error;}
finally {await desktop?.close(); await owner.close(); console.log('Artifacts: ' + directory);}
