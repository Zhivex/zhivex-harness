import {startApplicationCoordinator} from '@zhivex-ai/harness/application';
import {connectCoordinator, connectApplication} from '@zhivex-ai/harness/application/client';
import {startAssistantHost} from '@zhivex-ai/harness/assistant/host';
import {googleScopes} from '@zhivex-ai/harness/assistant/integrations/google';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {_electron as electron} from 'playwright';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = await mkdtemp('/tmp/zhx-assistant-ui-');
let stored = null, owner, desktop, page, gmailPosts = 0, outlookPosts = 0, pairingCode, paired = false;
const requests = [], errors = [];
const find = (value, predicate) => {if (predicate(value)) return value; if (typeof value === 'string') {try {return find(JSON.parse(value), predicate);} catch {return;}} if (value && typeof value === 'object') for (const child of Object.values(value)) {const result = find(child, predicate); if (result !== undefined) return result;}};
const base = createMockLanguageModel();
const model = {...base, async stream(input) {return (async function* () {
  const index = input.messages.findLastIndex(message => message.role === 'user');
  const messages = input.messages.slice(index), prompt = find(messages[0], value => typeof value === 'string' && value.startsWith('Use '));
  const resultMessages = messages.filter(message => message.role === 'tool');
  if (prompt && !resultMessages.length) {
    const match = prompt.match(/^Use (\w+) with exactly this input: (\{.*\})\. /);
    assert(match); yield {type: 'tool-call', toolCall: {id: crypto.randomUUID(), name: match[1], input: JSON.parse(match[2])}}; yield {type: 'finish', finishReason: 'tool-calls'};
  } else if ((prompt?.startsWith('Use microsoft_read_mail_propose_draft') || prompt?.startsWith('Use google_read_mail_propose_draft')) && resultMessages.length === 1) {
    const proposal = find(resultMessages, value => value && typeof value === 'object' && typeof value.proposalDigest === 'string');
    assert(proposal); yield {type: 'tool-call', toolCall: {id: crypto.randomUUID(), name: prompt.startsWith('Use google_') ? 'google_write_mail_apply_draft' : 'microsoft_write_apply', input: {requestId: proposal.requestId, proposalDigest: proposal.proposalDigest}}}; yield {type: 'finish', finishReason: 'tool-calls'};
  } else {yield {type: 'text-delta', textDelta: 'Action recorded.'}; yield {type: 'finish', finishReason: 'stop'};}
})();}};
const integrationFetch = async (input, init = {}) => {
  const url = new URL(String(input)); requests.push({path: url.pathname, method: init.method ?? 'GET'});
  if (url.hostname === 'api.telegram.org') {
    let result = true;
    if (url.pathname.endsWith('/getMe')) result = {id: 100, is_bot: true, username: 'fixture_bot'};
    else if (url.pathname.endsWith('/getWebhookInfo')) result = {url: ''};
    else if (url.pathname.endsWith('/getUpdates')) {
      result = pairingCode && !paired ? [{update_id: 1, message: {message_id: 1, date: Math.floor(Date.now()/1000), chat: {id: 1234, type: 'private'}, from: {id: 1234, is_bot: false}, text: '/start '+pairingCode}}] : [];
      if (result.length) paired = true;
      else await new Promise(resolve => setTimeout(resolve, 100));
    } else if (url.pathname.endsWith('/sendMessage')) result = {message_id: 2};
    return Response.json({ok: true, result});
  }
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') return Response.json({token_type: 'Bearer', access_token: 'fixture-google-token', refresh_token: 'fixture-google-refresh', expires_in: 3600, scope: googleScopes({mail: true, drive: true}).join(' ')});
  if (url.pathname.endsWith('/userinfo')) return Response.json({sub: 'google-fixture', email: 'owner@example.test', email_verified: true});
  if (url.hostname === 'login.microsoftonline.com' && url.pathname.endsWith('/token')) return Response.json({token_type: 'Bearer', access_token: 'fixture-microsoft-token', refresh_token: 'fixture-microsoft-refresh', expires_in: 3600, scope: 'User.Read Mail.ReadWrite'});
  if (url.hostname === 'graph.microsoft.com' && url.pathname === '/v1.0/me') return Response.json({id: 'ms-fixture', mail: 'owner@company.test'});
  if (url.pathname.endsWith('/drafts') && init.method === 'POST') {gmailPosts++; const body = JSON.parse(init.body); assert(Buffer.from(body.message.raw, 'base64url').toString().includes('guest@example.test')); return Response.json({id: 'gmail-draft', message: {id: 'gmail-message'}});}
  if (url.pathname === '/v1.0/me/messages' && init.method === 'POST') {outlookPosts++; assert.equal(JSON.parse(init.body).subject, 'Approved draft'); return Response.json({id: 'outlook-draft', isDraft: true, webLink: 'https://outlook.office.com/mail/draft'});}
  throw new Error('UNEXPECTED_EXTERNAL_REQUEST: ' + url.pathname);
};
const options = {integrationFetch, secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}, startHost: input => startAssistantHost({...input, engine: {...input.engine, modelInstance: model}})};
const wait = async check => {const end = Date.now() + 15000; while (!await check()) {if (Date.now() > end) throw new Error('CONDITION_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 50));}};
try {
  owner = await startApplicationCoordinator(directory + '/app', options);
  let coordinator = await connectCoordinator(directory + '/app');
  desktop = await electron.launch({executablePath: path.join(root, 'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root + '/packages/desktop/build/unified-main.cjs', '--assistant-directory', directory + '/app', '--user-data', directory + '/electron']});
  page = await desktop.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await desktop.evaluate(({shell}) => {shell.openExternal = async url => {globalThis.authorizationFixture = url;};});
  const button = name => page.getByRole('button', {name, exact: true});
  const go = name => page.locator('nav').getByRole('button', {name, exact: true}).click();
  const authorize = async name => {
    await desktop.evaluate(() => {globalThis.authorizationFixture = undefined;});
    await button(name).click(); await wait(() => desktop.evaluate(() => Boolean(globalThis.authorizationFixture)));
    const auth = new URL(await desktop.evaluate(() => globalThis.authorizationFixture));
    assert(!auth.searchParams.get('scope').includes('Mail.Send'));
    const callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('code', 'fixture'); callback.searchParams.set('state', auth.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
    await wait(async () => !(await coordinator.state()).state.calendar.pending);
  };
  await page.getByLabel('Assistant name', {exact: true}).fill('Phase four'); await button('Create assistant').click();
  await button('Configure optional connections now').click();
  await page.getByLabel('Account OAuth client ID', {exact: true}).fill('fixture.apps.googleusercontent.com');
  await page.getByLabel('Enable Google Drive read').check(); await authorize('Connect or reconnect Google');
  await page.getByText(/Google connected: owner@example.test/).waitFor();
  await page.getByLabel('Account OAuth client ID', {exact: true}).fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByLabel('Microsoft tenant ID (UUID)').fill('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); await authorize('Connect or reconnect Microsoft');
  await page.getByText('Microsoft connected: owner@company.test').waitFor();
  await page.getByLabel('Telegram bot token').fill('123456:synthetic-token-for-offline-fixtures'); await button('Verify Telegram bot').click();
  await button('Check private account').waitFor();
  pairingCode = new URL((await coordinator.state()).state.telegram.url).searchParams.get('start');
  await button('Check private account').click(); await page.getByLabel('This is my private Telegram account').check(); await button('Confirm Telegram account').click();
  await page.getByLabel('Provider', {exact: true}).selectOption('custom'); await page.getByLabel('API URL', {exact: true}).fill('https://example.invalid/v1'); await page.getByLabel('Model', {exact: true}).fill('fixture'); await page.getByLabel('API key', {exact: true}).fill('private-fixture-key');
  await page.getByLabel('Enable tasks and reminders').check(); await page.getByLabel('Enable reviewed proactive alerts').check(); await button('Connect and start').click();
  await button('Today').click();
  await page.getByRole('region', {name: 'Today overview'}).waitFor(); await page.locator('.new-conversation').click();
  const approve = async (recipient = false) => {
    await button('Load review').click();
    if (recipient) assert((await page.getByRole('region', {name:'Action review'}).innerText()).includes('guest@example.test'));
    await page.getByRole('region', {name: 'Action review'}).locator('input[type=checkbox]').evaluateAll(nodes => nodes.length);
    for (const checkbox of await page.getByRole('region', {name: 'Action review'}).getByRole('checkbox').all()) await checkbox.check();
    await button('Approve this action').click();
    await wait(async () => {const client = await connectApplication((await coordinator.state()).credentialsPath); const result = await client.command({method: 'session.list'}); return result.ok && result.data.sessions.every(session => session.runs.every(run => ['completed','failed','cancelled'].includes(run.status)));});
  };
  await go('Notes'); await page.getByLabel('Note title').fill('Durable personal note'); await page.getByLabel('Note text').fill('Kept through restart.'); await button('Ask to save note').click();
  let snapshot = await coordinator.state(), client = await connectApplication(snapshot.credentialsPath), projectId = client.projectId;
  await assert.rejects(coordinator.call('mail-draft-proposal', {projectId: 'foreign', provider: 'google', draft: {}}));
  await assert.rejects(coordinator.call('reply-watch-proposal', {projectId: 'foreign', watch: {}}));
  assert.equal((await coordinator.call('notes', {projectId})).total, 0); await approve(); await go('Notes'); await page.getByText('Durable personal note', {exact: true}).waitFor();
  await go('Proactive alerts'); await page.getByLabel('Enable alerts', {exact: true}).check(); await page.getByLabel('Maximum alerts per day').fill('3'); await button('Review proactive policy').click();
  assert.equal((await coordinator.call('personal-state', {projectId})).proactive.policy, null); await approve();
  assert.equal((await coordinator.call('personal-state', {projectId})).proactive.policy.maxPerDay, 3);
  await go('Proactive alerts');
  await page.getByLabel('Watch title').fill('Awaiting fixture reply'); await page.getByLabel('Thread or conversation ID').fill('thread-fixture');
  await page.getByLabel('Baseline message ID').fill('message-fixture'); await page.getByLabel('Expected reply from').fill('guest@example.test');
  await page.getByLabel('Reply due (local time)').fill('2026-11-16T14:00'); await button('Review reply watch').click();
  assert.equal((await coordinator.call('personal-state', {projectId})).proactive.watches.length, 0); await approve(true);
  assert.equal((await coordinator.call('personal-state', {projectId})).proactive.watches[0].status, 'waiting');
  await go('Proactive alerts'); await button('Review stopping watch').click(); await approve();
  assert.equal((await coordinator.call('personal-state', {projectId})).proactive.watches[0].status, 'cancelled');
  await go('Proactive alerts'); await page.screenshot({path: directory + '/proactive.png'});
  for (const provider of ['google', 'microsoft']) {
    await go('Mail drafts'); await page.getByLabel('Draft provider').selectOption(provider);
    await page.getByLabel('Recipients (comma separated)').fill('guest@example.test'); await page.getByLabel('Draft subject').fill('Approved draft'); await page.getByLabel('Draft body').fill('Only a draft, never sent.');
    await page.screenshot({path: directory + '/' + provider + '-draft.png'});
    await button('Review draft creation').click(); assert.equal(provider === 'google' ? gmailPosts : outlookPosts, 0); await approve(true); if ((provider === 'google' ? gmailPosts : outlookPosts) !== 1) {const c = await connectApplication((await coordinator.state()).credentialsPath); const sessions = await c.command({method:'session.list'}); for (const session of sessions.data.sessions) console.error(JSON.stringify({provider,requests,run:await c.command({method:'run.get',sessionId:session.sessionId,runId:session.runs.at(-1).runId})}));} assert.equal(provider === 'google' ? gmailPosts : outlookPosts, 1);
  }
  await go('Automations');
  await page.getByLabel('Summary local time').fill('09:30'); await page.getByLabel('Summary time zone').fill('UTC');
  const confirmAutomation = async label => {await button(label).click(); await page.getByLabel('I reviewed this automation change').check(); await button('Confirm automation change').click(); await page.getByRole('region', {name:'Review automation change'}).waitFor({state:'hidden'});};
  await confirmAutomation('Review schedule and activation'); assert.equal((await coordinator.call('automation',{projectId})).state.schedule.enabled,1);
  await confirmAutomation('Review pause'); assert.equal((await coordinator.call('automation',{projectId})).state.schedule.enabled,0);
  await go('Decision history'); await page.getByRole('heading', {name: 'Decision history', level: 1}).waitFor(); await page.screenshot({path: directory + '/history.png'});
  await button('Assistant settings').click(); await page.getByLabel('Agent display name').fill('Phase four updated'); await button('Save agent and model').click();
  await wait(async () => (await coordinator.state()).state.profiles[0].name === 'Phase four updated');
  await button('Edit integrations and tools').click(); assert.equal((await coordinator.state()).credentialsPath, undefined);
  await page.getByLabel('Account OAuth client ID', {exact: true}).fill('fixture.apps.googleusercontent.com'); await page.getByLabel('Enable Google Drive read').check(); await authorize('Connect or reconnect Google');
  await button('Save configuration and restart').click(); await page.getByRole('button', {name: 'Assistant settings', exact: true}).waitFor();
  assert.equal((await coordinator.state()).state.profiles.length, 1);
  assert.equal((await coordinator.call('notes', {projectId})).total, 1);
  await desktop.close(); desktop = undefined; await owner.close(); owner = await startApplicationCoordinator(directory + '/app', options); coordinator = await connectCoordinator(directory + '/app');
  client = await connectApplication((await coordinator.state()).credentialsPath); assert.equal(client.projectId, projectId);
  assert.equal((await coordinator.call('notes', {projectId})).total, 1); assert.equal((await coordinator.call('personal-state', {projectId})).proactive.policy.maxPerDay, 3);
  assert.equal(gmailPosts, 1); assert.equal(outlookPosts, 1); assert(!requests.some(request => /(?:sendMail|\/send)$/.test(request.path)));
  assert.deepEqual(errors, []);
  assert(!JSON.stringify(await coordinator.state()).match(/private-fixture-key|fixture-google-token|fixture-microsoft-token/));
  const report = {passed: true, directory, coreArtifactSha256: JSON.parse(await readFile(root + '/packages/desktop/.harness/installed.json', 'utf8')).sha256, gmailPosts, outlookPosts, checks: ['Google and Microsoft OAuth from Electron with exact scopes and loopback', 'notes and proactive policy require core review', 'Gmail and Outlook drafts apply once, never send', 'private Telegram pairing and reviewed automation configure/pause', 'reply watch creation and cancellation require exact core review', 'decision history', 'agent model/name update', 'existing agent reauthorization preserves identity and notes', 'restart preserves notes, proactive policy and conversations', 'no tokens in renderer state'], limitations: ['Injected local OAuth/provider/SecretStore fixtures; no external delivery or live-account certification']};
  await writeFile(directory + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {await page?.screenshot({path: directory + '/failure.png'}).catch(() => {}); throw error;} finally {await desktop?.close(); await owner?.close(); console.log('Evidence: ' + directory);}
