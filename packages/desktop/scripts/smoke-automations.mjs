// Real installed scheduler/core/Electron; Telegram linkage and agenda source are fixtures. No sends.
import {startApplicationCoordinator} from '@zhivex-ai/harness/application';
import {connectCoordinator, connectApplication} from '@zhivex-ai/harness/application/client';
import {startAssistantHost} from '@zhivex-ai/harness/assistant/host';
import {openTelegramStore} from '@zhivex-ai/harness/assistant/telegram/store';
import {createDailyScheduler} from '@zhivex-ai/harness/assistant/automation/scheduler';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {_electron as electron} from 'playwright';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await mkdtemp('/tmp/zhx-automation-ui-'); await mkdir(directory + '/telegram', {mode: 0o700});
const store = await openTelegramStore(directory + '/telegram');
let stored = null, available = true, queued = 0, desktop, page;
const scheduler = createDailyScheduler(store, {binding: 'fixture', calendarId: 'primary', async list() {return {events: [], complete: true, nextPageToken: null};}}, () => {queued++;}, () => Date.parse('2026-11-14T00:00:00Z'));
const owner = await startApplicationCoordinator(directory + '/app', {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: async input => {
  const host = await startAssistantHost({...input, engine: {...input.engine, modelInstance: createMockLanguageModel()}});
  return {...host, get automation() {return available ? {status: scheduler.status, command: text => store.transaction(() => scheduler.command(text, 'fixture-owner'))} : undefined;}, diagnostics: () => ({...host.diagnostics(), telegram: {linked: true}})};
}});
const client = await connectCoordinator(directory + '/app'), errors = [];
try {
  for (const [name, value] of [['begin', {name: 'Automation fixture'}], ['provider', {baseURL: 'https://example.invalid/v1', model: 'mock', apiKey: 'fixture'}], ['start', {}]]) await client.call('action', {name, value});
  const projectId = (await connectApplication((await client.state()).credentialsPath)).projectId;
  const state = () => client.call('automation', {projectId});
  desktop = await electron.launch({executablePath: path.join(root, 'packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness'), args: ['--assistant-directory', directory + '/app', '--user-data', directory + '/electron'], env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME}});
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', {name, exact: true});
  const status = text => page.getByText(text + ' · Delivery: Telegram · Account linked', {exact: true}).waitFor();
  const confirm = async () => {await page.getByLabel('I reviewed this automation change', {exact: true}).check(); await button('Confirm automation change').click();};
  await button('Automations').click(); await status('Not configured');
  await page.getByLabel('Summary local time', {exact: true}).fill('09:30');
  await page.getByLabel('Summary time zone', {exact: true}).fill('UTC');
  await button('Review schedule and activation').click();
  assert.equal((await state()).state.schedule, null); assert.equal(await button('Confirm automation change').isEnabled(), false);
  await page.screenshot({path: directory + '/review.png'});
  await confirm(); await status('Active'); assert.equal((await state()).state.schedule.enabled, 1); assert.equal(queued, 0);
  await page.screenshot({path: directory + '/active.png'});
  await button('Review pause').click();
  await client.call('automation', {projectId, change: {action: 'configure', localTime: '10:00', timeZone: 'UTC', expectedDigest: (await state()).digest, confirmed: true}});
  await confirm(); await page.getByRole('alert').filter({hasText: 'The change was not confirmed'}).waitFor();
  assert.equal((await state()).state.schedule.enabled, 1);
  await button('Refresh automation').click(); await button('Review pause').click(); await confirm(); await status('Paused');
  assert.equal((await state()).state.schedule.enabled, 0);
  available = false; await button('Refresh automation').click();
  await page.getByText('A configured summary source and Telegram connection are required. This assistant has no daily-summary scheduler.', {exact: true}).waitFor();
  await page.screenshot({path: directory + '/unavailable.png'}); assert.deepEqual(errors, []);
  const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
  const report = {passed: true, directory, coreArtifactSha256: installed.sha256, checks: ['no effect before confirmation', 'schedule persisted', 'stale review rejected', 'pause persisted', 'unavailable scheduler explained', 'no external sends'], limitation: 'Linked Telegram and source are fixtures. Does not certify live integration or onboarding.'};
  await writeFile(directory + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {if (page) {console.error(await page.locator('body').innerText()); await page.screenshot({path: directory + '/failure.png'});} throw error;}
finally {await desktop?.close(); await owner.close(); await scheduler.close(); await store.close(); console.log('Artifacts: ' + directory);}
