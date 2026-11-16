import { execFileSync, spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { AsyncEntry } from '@napi-rs/keyring';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await realpath(await mkdtemp('/tmp/zhx-autonomous-'));
const autoRecoverNodeHost = process.argv.includes('--auto-recover-node-host');
const recoverNodeHost = autoRecoverNodeHost || process.argv.includes('--recover-node-host');
const nodeHost = recoverNodeHost || process.argv.includes('--node-host');
const measureFootprint = process.argv.includes('--footprint');
const measureBaseline = measureFootprint || process.argv.includes('--baseline');
if (measureFootprint && nodeHost) throw new Error('Footprint baseline requires the autonomous bundled host');
const baseline = {launches: [], samples: []};
const testPersonal = process.argv.includes('--personal');
const testGit = process.argv.includes('--git');
const testTools = testGit || process.argv.includes('--tools');
const testCode = testTools || process.argv.includes('--code');
const workspace = path.join(directory, 'code-a'), secondWorkspace = path.join(directory, 'code-b');
await mkdir(workspace); await mkdir(secondWorkspace); await writeFile(path.join(workspace, 'review.txt'), 'before\n');
const checkScript = `bun -e "require('node:fs').writeFileSync('check-ran.txt','ok'); console.log('CHECK_OK')"`;
if (testTools) {
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Use Bun for project checks.\n');
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({name: 'code-fixture', packageManager: 'bun@1.4.3', scripts: {test: checkScript}}));
  await writeFile(path.join(workspace, '.gitignore'), '.zhivex-harness/\n');
  const git = args => execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['add', 'review.txt', 'package.json', '.gitignore', 'AGENTS.md']); git(['commit', '-qm', 'initial']);
}
if (testCode) for (const folder of [workspace, secondWorkspace]) execFileSync('git', ['-C', folder, 'init', '-q']);
const entry = new AsyncEntry('ai.zhivex.assistant', createHash('sha256').update(directory).digest('hex'));
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text), answer = 'Autonomous assistant is ready.';
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const userIndex = body.messages.findLastIndex(message => message.role === 'user');
    const content = body.messages[userIndex]?.content;
    const promptText = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
    const personalRequest = promptText.match(/^Use (daily_write_[a-z_]+) with exactly this input: (.+)\. Request approval/);
    if (testPersonal && personalRequest && !body.messages.slice(userIndex + 1).some(message => message.role === 'tool')) {
      const input = JSON.parse(personalRequest[2]);
      res.write(`data: ${JSON.stringify({id: 'personal', choices: [{index: 0, delta: {tool_calls: [{index: 0, id: `personal_${input.requestId}`, type: 'function', function: {name: personalRequest[1], arguments: JSON.stringify(input)}}]}, finish_reason: null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id: 'personal', choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]})}\n\n`); res.end('data: [DONE]\n\n'); return;
    }
    if (JSON.stringify(body.messages[userIndex]).includes('code-edit:') && !body.messages.slice(userIndex + 1).some(message => message.role === 'tool')) {
      const input = {path: 'review.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before\n').digest('hex'), oldText: 'before', newText: 'after'};
      res.write(`data: ${JSON.stringify({id: 'edit', choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'edit1', type: 'function', function: {name: 'apply_reviewed_replacement', arguments: JSON.stringify(input)}}]}, finish_reason: null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id: 'edit', choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]})}\n\n`); res.end('data: [DONE]\n\n'); return;
    }
    if (JSON.stringify(body.messages[userIndex]).includes('using run_check') && !body.messages.slice(userIndex + 1).some(message => message.role === 'tool')) {
      res.write(`data: ${JSON.stringify({id: 'check', choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'check1', type: 'function', function: {name: 'run_check', arguments: JSON.stringify({check: 'test', expectedScript: checkScript})}}]}, finish_reason: null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id: 'check', choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]})}\n\n`); res.end('data: [DONE]\n\n'); return;
    }
    for (const value of [{ id: 'r', choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] }, { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end('data: [DONE]\n\n');
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let nodeService, coordinatorClient;
let desktop; const errors = [], logs = []; const packaged = process.argv.includes('--packaged');
const deadline = setTimeout(() => desktop?.process().kill('SIGKILL'), 120_000);
async function waitForAsync(check) {
  const deadline = Date.now() + 30000;
  while (!await check()) {if (Date.now() >= deadline) throw new Error('ASYNC_CONDITION_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 75));}
}
function residentSample(label) {
  const pid = desktop.process().pid;
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {encoding: 'utf8'}).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]); let added = true;
  while (added) {added = false; for (const [child, parent] of rows) if (owned.has(parent) && !owned.has(child)) {owned.add(child); added = true;}}
  const processes = rows.filter(([child]) => owned.has(child)).map(([pid, parentPid, rssKiB]) => ({pid, parentPid, rssKiB}));
  let physicalFootprint;
  if (measureFootprint) {
    const filename = path.join(directory, `footprint-${label}.json`);
    execFileSync('/usr/bin/footprint', ['--noCategories', '-j', filename, ...[...owned].map(String)], {timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']});
    const report = JSON.parse(execFileSync('/bin/cat', [filename], {encoding: 'utf8'}));
    assert.equal(report.errors.length, 0, 'Footprint errors');
    assert.equal(report.warnings.length, 0, 'Footprint warnings');
    assert([...owned].every(child => report.processes.some(item => item.pid === child)), 'Footprint must include every selected process');
    assert(Number.isFinite(report['total footprint']) && report['total footprint'] > 0, 'Invalid footprint total');
    physicalFootprint = {bytes: report['total footprint'], filename, pids: [...owned]};
  }
  baseline.samples.push({label, rootPid: pid, processes, rssSumKiB: processes.reduce((sum, process) => sum + process.rssKiB, 0), ...(physicalFootprint ? {physicalFootprint} : {})});
}
async function open() {
  const started = performance.now();
  desktop = await electron.launch({ executablePath: packaged ? path.join(root, 'packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness') : path.join(root, 'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [...(packaged ? [] : [path.join(root, 'packages/desktop')]), '--assistant-directory', directory, '--user-data', path.join(directory, 'electron')],
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, timeout: 45000 });
  desktop.process().stderr?.on('data', value => logs.push(value.toString()));
  const page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('.unified-shell');
  if (measureBaseline) baseline.launches.push({kind: baseline.launches.length ? 'reopen' : 'fresh-data', shellDomMs: performance.now() - started});
  return page;
}
try {
  if (nodeHost) {
    await page.getByRole('button', {name: 'Notes', exact: true}).click();
    await page.getByLabel('Note title', {exact: true}).fill('Desktop fixture note');
    await page.getByLabel('Note text', {exact: true}).fill('Private note <script>window.noteExecuted = true</script>');
    await page.getByRole('button', {name: 'Ask to save note', exact: true}).click();
    await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('button', {name: 'Approve this action', exact: true}).waitFor();
    assert.equal((await page.evaluate(id => window.zhivex.notes(id, {}), personalId)).total, 0);
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await waitForAsync(() => page.evaluate(async id => (await window.zhivex.notes(id, {})).total === 1, personalId));
    await page.getByRole('button', {name: 'Notes', exact: true}).click();
    await page.getByRole('button', {name: 'Read note', exact: true}).click();
    await page.getByRole('region', {name: 'Selected note', exact: true}).getByText('Private note <script>window.noteExecuted = true</script>', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.noteExecuted), undefined);
    await page.getByLabel('Search notes', {exact: true}).fill('missing note');
    await page.getByRole('button', {name: 'Search notes', exact: true}).click();
    await page.getByText('No notes match this search.', {exact: true}).waitFor();
    await page.getByLabel('Search notes', {exact: true}).fill('Private note');
    await page.getByRole('button', {name: 'Search notes', exact: true}).click();
    await page.getByText('Desktop fixture note', {exact: true}).waitFor();
    await page.screenshot({path: path.join(directory, 'notes-saved.png')});
    const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
    const core = path.join(installed.install, 'node_modules/@zhivex-ai/harness');
    const {connectCoordinator} = await import(path.join(core, 'dist/engine/application-client.js'));
    nodeService = spawn('node', [path.join(core, 'dist/service-cli.js'), '--application-directory', directory], {stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
    nodeService.stderr.on('data', value => logs.push(value.toString()));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('NODE_HOST_START_TIMEOUT')), 30000); let output = '';
      nodeService.once('error', error => {clearTimeout(timer); reject(error);});
      nodeService.once('exit', code => {clearTimeout(timer); reject(new Error('NODE_HOST_EXIT_' + code));});
      nodeService.stdout.on('data', value => {output += value; if (output.includes('application-ready')) {clearTimeout(timer); resolve();}});
    });
    coordinatorClient = await connectCoordinator(directory);
  }
  let page = await open();
  if (measureFootprint) {await page.getByLabel('Assistant name', {exact: true}).waitFor(); await new Promise(resolve => setTimeout(resolve, 1500)); residentSample('unconfigured-onboarding');}
  await page.getByLabel('Assistant name', { exact: true }).fill('Autonomous test');
  await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
  assert.equal(await page.getByLabel('Google OAuth client ID', {exact: true}).count(), 0, 'Optional connections should not block first use');
  assert.equal(await page.getByLabel('API format', {exact: true}).isVisible(), false, 'Protocol details stay in advanced options');
  await page.getByRole('button', {name: 'Code', exact: true}).click();
  await page.getByRole('button', {name: 'Changes', exact: true}).click();
  assert.equal(await page.getByRole('button', {name: 'Code', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.getByRole('heading', {name: 'Open a Code project to get started', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Assistant settings', exact: true}).click();
  assert.equal(await page.getByLabel('API URL', { exact: true }).count(), 0, 'A supported provider must not ask for an endpoint');
  await page.getByLabel('Provider', { exact: true }).selectOption('custom');
  await page.getByLabel('API URL', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('Model', { exact: true }).fill('test-model');
  await page.getByLabel('API key', { exact: true }).fill('fake-test-key');
  await page.getByLabel('Allow HTTP for a local model on this computer').check();
  if (testPersonal) {
    await page.getByRole('button', {name: 'Configure optional connections now', exact: true}).click();
    await page.getByLabel('Enable tasks and reminders', {exact: true}).check();
  }
  await page.screenshot({ path: path.join(directory, 'onboarding.png') });
  await page.getByRole('button', { name: 'Connect and start', exact: true }).click();
  await page.getByRole('button', { name: 'Assistant settings', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.setup-panel'));
  assert.equal((await page.evaluate(() => window.zhivex.hosts()))[0].area, 'assistant');
  if (measureBaseline) {await new Promise(resolve => setTimeout(resolve, 1500)); residentSample('configured-before-conversation-idle');}
  await page.getByRole('heading', {name: 'Your model is connected.', exact: true}).waitFor();
  assert.equal(await page.getByLabel('Message', {exact: true}).evaluate(element => element === document.activeElement), true, 'The first message should be ready to type');
  await page.getByLabel('Message', { exact: true }).fill('Hello from the autonomous app');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Autonomous assistant is ready.', { exact: true }).first().waitFor();
  await page.getByText('Response complete', {exact: true}).waitFor();
  const firstSessions = (await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).data.sessions;
  assert.equal(firstSessions.length, 1, 'The first send creates exactly one conversation');
  assert.equal(firstSessions[0].runs.length, 1, 'The first message must not be sent twice');
  await page.screenshot({ path: path.join(directory, 'conversation.png') });
  if (measureBaseline) {await new Promise(resolve => setTimeout(resolve, 1500)); residentSample('after-first-conversation-idle');}
  if (measureBaseline) {
    await page.getByRole('button', {name: 'Assistant', exact: true}).click();
    await page.getByRole('button', {name: 'Workspace', exact: true}).click();
    const beforeRuns = (await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).data.sessions[0].runs.length;
    const turns = 12, body = 'Baseline context sample. '.repeat(100);
    for (let turn = 0; turn < turns; turn++) {
      await page.getByLabel('Message', {exact: true}).fill(`Baseline turn ${turn}: ${body}`);
      await page.getByRole('button', {name: 'Send message', exact: true}).click();
      await page.waitForFunction(() => document.querySelector('textarea#prompt')?.value === '');
      await page.waitForFunction(() => document.querySelector('.context-row strong')?.textContent === 'completed');
      await page.getByRole('button', {name: 'Send message', exact: true}).waitFor();
    }
    await new Promise(resolve => setTimeout(resolve, 1500)); residentSample('extended-conversation-idle');
    const afterRuns = (await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).data.sessions[0].runs;
    assert.equal(afterRuns.length, beforeRuns + turns); assert(afterRuns.slice(-turns).every(run => run.status === 'completed'));
    assert.equal(new Set(baseline.samples.map(sample => sample.rootPid)).size, 1, 'Baseline samples must share one Electron process');
    baseline.extended = {additionalTurns: turns, promptCharactersPerTurn: body.length, provider: 'local deterministic fixture'};
    baseline.limitations = ['Instrumented Playwright launch; shell DOM is not first paint or full readiness', 'RSS sum counts shared pages per process and may omit reparented OS helpers', 'One fresh-data launch and one reopen are a pilot, not a distribution or regression budget'];
  }

  await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 390, height: 900}));
  await page.waitForFunction(() => innerWidth <= 390);
  assert.equal(await page.locator('#workspace-navigation').evaluate(node => node.inert), true);
  const navigationToggle = page.getByRole('button', {name: 'Toggle navigation', exact: true});
  await navigationToggle.focus(); await page.keyboard.press('Enter');
  await page.getByRole('dialog', {name: 'Workspace navigation', exact: true}).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close navigation');
  assert.equal(await page.locator('main.workspace').evaluate(node => node.inert), true);
  await page.locator('.sidebar button:visible').last().focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close navigation');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Dark appearance');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Toggle navigation');
  assert.equal(await page.locator('main.workspace').evaluate(node => node.inert), false);
  await page.getByLabel('Message', {exact: true}).focus(); await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => document.activeElement?.getAttribute('placeholder') === 'Search conversations…');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'prompt');
  await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 1440, height: 960}));
  await page.waitForFunction(() => innerWidth >= 1400);
  assert.equal(await page.locator('#workspace-navigation').evaluate(node => node.inert), false);
  const first = await page.evaluate(() => window.zhivex.command('assistant', { method: 'session.list' }));
  assert.equal(first.ok, true); assert.equal(first.data.sessions.length, 1);
  const profile = (await page.evaluate(() => window.zhivex.setupState())).profiles[0].id;
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  if (testPersonal) {
    const personalId = (await page.evaluate(() => window.zhivex.hosts())).find(host => host.area === 'assistant').projectId;
    await page.getByRole('button', {name: 'Tasks & reminders', exact: true}).click();
    await page.getByLabel('Task title', {exact: true}).fill('Desktop fixture task');
    await page.getByRole('button', {name: 'Ask to create task', exact: true}).click();
    await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('button', {name: 'Approve this action', exact: true}).waitFor();
    assert.equal((await page.evaluate(id => window.zhivex.personalState(id), personalId)).total, 0);
    await page.screenshot({path: path.join(directory, 'personal-task-review.png')});
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await waitForAsync(() => page.evaluate(async id => (await window.zhivex.personalState(id)).total === 1, personalId));
    await page.getByRole('button', {name: 'Tasks & reminders', exact: true}).click();
    await page.getByText('Desktop fixture task', {exact: true}).waitFor();
    await page.getByLabel('Reminder text', {exact: true}).fill('Desktop fixture reminder');
    await page.getByLabel('Reminder date', {exact: true}).fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
    await page.getByLabel('Reminder time', {exact: true}).fill('12:00');
    await page.getByLabel('Time zone', {exact: true}).fill('UTC');
    await page.getByRole('button', {name: 'Ask to schedule reminder', exact: true}).click();
    await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('button', {name: 'Approve this action', exact: true}).waitFor();
    assert.equal((await page.evaluate(id => window.zhivex.personalState(id), personalId)).reminders.length, 0);
    await page.screenshot({path: path.join(directory, 'personal-reminder-review.png')});
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await waitForAsync(() => page.evaluate(async id => (await window.zhivex.personalState(id)).reminders.length === 1, personalId));
    await page.getByRole('button', {name: 'Notes', exact: true}).click();
    await page.getByLabel('Note title', {exact: true}).fill('Desktop fixture note');
    await page.getByLabel('Note text', {exact: true}).fill('Private note <script>window.noteExecuted = true</script>');
    await page.getByRole('button', {name: 'Ask to save note', exact: true}).click();
    await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('button', {name: 'Approve this action', exact: true}).waitFor();
    assert.equal((await page.evaluate(id => window.zhivex.notes(id, {}), personalId)).total, 0);
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await waitForAsync(() => page.evaluate(async id => (await window.zhivex.notes(id, {})).total === 1, personalId));
    await page.getByRole('button', {name: 'Notes', exact: true}).click();
    await page.getByRole('button', {name: 'Read note', exact: true}).click();
    await page.getByRole('region', {name: 'Selected note', exact: true}).getByText('Private note <script>window.noteExecuted = true</script>', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.noteExecuted), undefined);
    await page.getByLabel('Search notes', {exact: true}).fill('missing note');
    await page.getByRole('button', {name: 'Search notes', exact: true}).click();
    await page.getByText('No notes match this search.', {exact: true}).waitFor();
    await page.getByLabel('Search notes', {exact: true}).fill('Private note');
    await page.getByRole('button', {name: 'Search notes', exact: true}).click();
    await page.getByText('Desktop fixture note', {exact: true}).waitFor();
    await page.screenshot({path: path.join(directory, 'notes-saved.png')});
    const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
    const cliEntry = path.join(installed.install, 'node_modules/@zhivex-ai/harness/dist/zhx.js');
    const personalCli = action => JSON.parse(execFileSync('node', [cliEntry, 'personal', action, '--application-directory', directory, '--json'], {encoding: 'utf8', timeout: 15000}));
    const tasks = personalCli('tasks'), reminders = personalCli('reminders');
    const notes = personalCli('notes');
    assert.equal(notes.projectId, personalId); assert.equal(notes.total, 1); assert.equal(notes.notes[0].title, 'Desktop fixture note');
    assert.equal(tasks.projectId, personalId); assert.equal(tasks.total, 1); assert.equal(tasks.tasks[0].title, 'Desktop fixture task');
    assert.equal(reminders.projectId, personalId); assert.equal(reminders.reminders[0].text, 'Desktop fixture reminder');
    await page.getByRole('button', {name: 'Tasks & reminders', exact: true}).click();
    await page.getByText('Desktop fixture reminder', {exact: true}).waitFor();
    await page.screenshot({path: path.join(directory, 'personal-saved.png')});
    await page.getByRole('button', {name: 'Today', exact: true}).click();
    const overview = page.getByRole('region', {name: 'Today overview', exact: true});
    await overview.getByText('Desktop fixture task', {exact: true}).waitFor();
    await overview.getByText('Saved reminders (1)', {exact: true}).click();
    await overview.getByText('Desktop fixture reminder', {exact: true}).waitFor();
    await page.getByText('No calendar connected', {exact: true}).waitFor();
    assert.equal(await overview.getByText('1 task to do', {exact: true}).count(), 1);
    await overview.getByRole('button', {name: 'Refresh overview', exact: true}).click();
    await overview.getByText('Desktop fixture task', {exact: true}).waitFor();
    await page.screenshot({path: path.join(directory, 'today-overview.png')});
    await overview.getByRole('button', {name: 'Manage tasks & reminders', exact: true}).click();

    await page.getByRole('button', {name: 'Dark appearance', exact: true}).click();
    await page.screenshot({path: path.join(directory, 'personal-dark.png')});
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 390, height: 900}));
    await page.waitForFunction(() => innerWidth <= 390);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: path.join(directory, 'personal-compact.png')});
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 1440, height: 960}));
    await page.waitForFunction(() => innerWidth >= 1400);
    await page.getByRole('button', {name: 'Light appearance', exact: true}).click();
    await page.getByRole('button', {name: 'View conversation', exact: true}).click();
  }
  if (testCode) {
    await page.getByRole('button', {name: 'Code', exact: true}).click();
    await page.getByRole('button', {name: 'Choose project folder', exact: true}).waitFor();
    await desktop.evaluate(({dialog}, folder) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]}); }, directory);
    await page.getByRole('button', {name: 'Choose project folder', exact: true}).click();
    await page.getByRole('alert').filter({hasText: 'This folder is not a Git working tree.'}).waitFor();
    assert.equal((await page.evaluate(() => window.zhivex.codeState())).projects.length, 0);
    assert.equal((await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).ok, true);
    await desktop.evaluate(({dialog}, folder) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]}); }, workspace);
    await page.getByRole('button', {name: 'Choose project folder', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('.setup-panel'));
    assert.equal((await page.evaluate(() => window.zhivex.hosts())).length, 2);
    await page.getByRole('button', {name: /^New conversation/}).first().click();
    await page.getByLabel('Message', {exact: true}).fill('code-edit: update review.txt');
    await page.getByRole('button', {name: 'Send message', exact: true}).click();
    await page.getByText('An action needs your review.', {exact: true}).waitFor();
    assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'before\n');
    // A pending review must prevent project switching, without interrupting Assistant.
    await page.getByRole('button', {name: 'Code projects', exact: true}).click();
    await desktop.evaluate(({dialog}, folder) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]}); }, secondWorkspace);
    await page.getByRole('button', {name: 'Choose project folder', exact: true}).click();
    await page.getByRole('alert').filter({hasText: 'CODE_PROJECT_BUSY'}).waitFor();
    assert.equal((await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).data.sessions.length, 1);
    await page.getByRole('button', {name: 'Back to Code', exact: true}).click();
    await page.getByRole('button', {name: 'Review action', exact: true}).click();
    await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('checkbox', {name: 'Viewed', exact: true}).check();
    await page.screenshot({path: path.join(directory, 'code-review.png')});
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await page.getByText('Autonomous assistant is ready.', {exact: true}).first().waitFor();
    assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
    if (testTools) {
      await page.getByRole('button', {name: 'Context', exact: true}).click();
      await page.getByRole('region', {name: 'Code context', exact: true}).getByText('AGENTS.md', {exact: true}).waitFor();
      await page.getByRole('button', {name: 'Refresh context', exact: true}).click();
      await page.getByText('No project skills indexed.', {exact: true}).waitFor();
      const context = await page.evaluate(async () => {const hosts = await window.zhivex.hosts(); return window.zhivex.codeContext(hosts.find(host => host.area === 'code').projectId);});
      assert.equal(await page.evaluate(async () => {try {await window.zhivex.codeContext('wrong-project'); return false;} catch {return true;}}), true);
      assert.equal(context.sources[0].path, 'AGENTS.md'); assert(!JSON.stringify(context).includes('Use Bun for project checks.'));
      const contextInstall = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
      const contextCli = JSON.parse(execFileSync('node', [path.join(contextInstall.install, 'node_modules/@zhivex-ai/harness/dist/zhx.js'), 'projects', 'context', '--application-directory', directory, '--json'], {encoding: 'utf8', timeout: 15000}));
      const {kind: contextKind, projectId: contextProject, ...cliContext} = contextCli;
      assert.equal(contextKind, 'application-code-context'); assert(contextProject); assert.deepEqual(cliContext, context);
      await page.screenshot({path: path.join(directory, 'code-context.png')});
      await page.getByRole('button', {name: 'Checkpoints', exact: true}).click();
      await page.getByRole('button', {name: 'Workspace checkpoints', exact: true}).click();
      await page.getByText('Capture current files', {exact: true}).click();
      await page.getByLabel('Relative paths, one per line').fill('review.txt');
      await page.getByRole('button', {name: 'Capture selected files', exact: true}).click();
      await page.getByRole('button', {name: 'Prepare restore review', exact: true}).waitFor();
      await writeFile(path.join(workspace, 'review.txt'), 'changed after checkpoint\n');
      await page.getByRole('button', {name: 'Prepare restore review', exact: true}).click();
      await page.getByLabel('I reviewed this operation and its effects.').check();
      await page.screenshot({path: path.join(directory, 'checkpoint-review.png')});
      await page.getByRole('button', {name: 'Confirm restoration', exact: true}).click();
      await page.getByLabel('Message', {exact: true}).waitFor();
      assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
      const rejected = await page.evaluate(async () => {try {await window.zhivex.command('code', {method: 'restore.apply'}); return false;} catch {return true;}}); assert.equal(rejected, true);
      await page.getByRole('button', {name: 'Execution', exact: true}).click();
      await page.getByRole('button', {name: 'Reload checks', exact: true}).click();
      await page.getByRole('button', {name: 'Ask Code to run test', exact: true}).click();
      await page.getByRole('button', {name: 'Review execution', exact: true}).click();
      await page.getByRole('button', {name: 'Load review', exact: true}).click();
      await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
      await page.waitForFunction(() => document.querySelector('.context-row strong')?.textContent === 'completed');
      assert.equal(await readFile(path.join(workspace, 'check-ran.txt'), 'utf8'), 'ok');
      await page.getByRole('button', {name: 'Execution', exact: true}).click();
      await page.getByRole('region', {name: 'Recorded check results', exact: true}).getByText('Exit code: 0', {exact: true}).waitFor();
      await page.getByText('Check passed.', {exact: true}).waitFor();
      await page.screenshot({path: path.join(directory, 'execution-result.png')});
      await page.getByRole('button', {name: 'Worktrees', exact: true}).click();
      await page.getByLabel('Worktree title', {exact: true}).fill('Isolated task');
      await page.getByLabel('Branch (optional)', {exact: true}).fill('feat/isolated-task');
      await page.getByRole('button', {name: 'Create worktree', exact: true}).click();
      await page.getByRole('button', {name: 'Open worktree', exact: true}).waitFor();
      const worktree = (await page.evaluate(() => window.zhivex.worktrees()))[0];
      assert.equal(await readFile(path.join(worktree.workspace, 'review.txt'), 'utf8'), 'before\n');
      await page.screenshot({path: path.join(directory, 'worktrees.png')});
      await page.getByRole('button', {name: 'Open worktree', exact: true}).click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Worktrees"]'));
      assert.equal((await page.evaluate(() => window.zhivex.command('code', {method: 'session.list'}))).data.sessions.length, 0);
      await page.getByRole('button', {name: 'Worktrees', exact: true}).click();
      await page.getByRole('button', {name: 'Back to source project', exact: true}).click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Worktrees"]'));
      await page.getByRole('button', {name: 'Worktrees', exact: true}).click();
      await page.getByRole('button', {name: 'Review removal', exact: true}).click();
      await page.getByLabel('I reviewed this checkout and its removal.').check();
      await page.getByRole('button', {name: 'Confirm removal', exact: true}).click();
      await waitForAsync(() => page.evaluate(async () => { try { return (await window.zhivex.worktrees())[0]?.status === 'removed'; } catch { return false; } }));
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Reload worktrees' && !button.disabled));
      assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
      if (testGit) {
        const prior = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
        await page.getByRole('button', {name: 'Git', exact: true}).click();
        await page.locator('.git-panel > summary').click();
        await page.getByRole('button', {name: 'Refresh files', exact: true}).click();
        await page.locator('[data-git-path="review.txt"]').check();
        await page.getByRole('button', {name: 'Stage selected files', exact: true}).click();
        await page.waitForFunction(() => { const input = document.querySelector('[data-git-path="review.txt"]'); return input && !input.disabled && input.parentElement.textContent.includes('Staged: select to review'); });
        await page.locator('[data-git-path="review.txt"]').check();
        await page.getByLabel('Commit message', {exact: true}).fill('Reviewed change from Electron');
        await page.getByRole('button', {name: 'Review commit', exact: true}).click();
        await page.getByRole('region', {name: 'Commit review', exact: true}).waitFor();
        assert.equal(execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), prior);
        await page.screenshot({path: path.join(directory, 'git-commit-review.png')});
        await page.getByRole('button', {name: 'Authorize local commit', exact: true}).click();
        await page.getByRole('status').filter({hasText: 'Commit created:'}).waitFor();
        const current = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
        assert.notEqual(current, prior);
        assert.equal(execFileSync('git', ['-C', workspace, 'show', 'HEAD:review.txt'], {encoding: 'utf8'}), 'after\n');
        assert.equal(execFileSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'], {encoding: 'utf8'}).trim(), '2');
        await page.screenshot({path: path.join(directory, 'git-commit-result.png')});
      }
    }
    await page.getByRole('button', {name: 'Workspace', exact: true}).click();
    await page.locator('.session-list button').last().click();
    await page.getByLabel('Message', {exact: true}).fill('Unsent Code draft');
    const selectedCodeSession = await page.locator('.session-list .selected').getAttribute('data-session-id');
    await page.getByRole('button', {name: 'Execution', exact: true}).click();
    await page.getByRole('button', {name: 'Code projects', exact: true}).click();
    await page.getByRole('button', {name: 'Choose project folder', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('.setup-panel'));
    assert.equal((await page.evaluate(() => window.zhivex.command('code', {method: 'session.list'}))).data.sessions.length, 0);
    await page.getByRole('button', {name: 'Code projects', exact: true}).click();
    await page.getByRole('button', {name: 'Open project', exact: true}).click();
    await page.getByRole('heading', {name: 'Run project checks', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Workspace', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'Unsent Code draft');
    assert.equal(await page.locator('.session-list .selected').getAttribute('data-session-id'), selectedCodeSession);
    await page.getByText('Autonomous assistant is ready.', {exact: true}).first().waitFor();
    await page.screenshot({path: path.join(directory, 'code-workspace.png')});
    await page.getByRole('button', {name: 'Assistant', exact: true}).click();
    await page.getByText('Hello from the autonomous app', {exact: true}).waitFor();
    assert.notEqual(await page.getByLabel('Message', {exact: true}).inputValue(), 'Unsent Code draft');
    await page.getByLabel('Message', {exact: true}).fill('Unsent Assistant draft');
  }
  // Window close must preserve the owned host; Quit must shut it down cleanly.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal((await page.evaluate(() => window.zhivex.command('assistant', { method: 'session.list' }))).ok, true);
  assert.equal(await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  // This is the same native Menu instance used by the status item.
  await desktop.evaluate(({Menu}) => { const menu = Menu.getApplicationMenu(); const item = menu.getMenuItemById('show-zhivex'); item.click(); });
  assert.equal(await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await desktop.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('hide-zhivex').click());
  assert.equal(await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await desktop.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('show-zhivex').click());
  // Exercise the real before-quit handler; only the native dialog response is simulated.
  if (!nodeHost) {
  await desktop.evaluate(({ Menu, dialog }) => {
    globalThis.quitPrompt = null;
    dialog.showMessageBox = async options => { globalThis.quitPrompt = options; return {response: 0, checkboxChecked: false}; };
    Menu.getApplicationMenu().getMenuItemById('quit-zhivex').click();
  });
  for (let attempt = 0; attempt < 100 && !await desktop.evaluate(() => Boolean(globalThis.quitPrompt)); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  const quitPrompt = await desktop.evaluate(() => globalThis.quitPrompt);
  assert.equal(quitPrompt.cancelId, 0);
  assert.match(quitPrompt.detail, /Other clients using this service will disconnect/);
  assert.equal((await page.evaluate(() => window.zhivex.command('assistant', { method: 'session.list' }))).ok, true);
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false}); });
  }
  await desktop.close(); desktop = undefined;
  if (nodeHost) {assert.equal(nodeService.exitCode, null); assert.equal((await coordinatorClient.state()).state.ready, true);}
  page = await open();
  await page.getByText('Autonomous assistant is ready.', { exact: true }).first().waitFor();
  assert.equal((await page.evaluate(() => window.zhivex.setupState())).profiles[0].id, profile);
  assert.equal((await page.evaluate(() => window.zhivex.command('assistant', { method: 'session.list' }))).data.sessions.length, 1);
  if (testCode) await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'Unsent Assistant draft');
  await page.screenshot({ path: path.join(directory, 'reopened.png') });
  assert.equal(JSON.stringify(await page.evaluate(() => window.zhivex.setupState())).includes('fake-test-key'), false);
  if (testPersonal) {
    const id = (await page.evaluate(() => window.zhivex.hosts())).find(host => host.area === 'assistant').projectId;
    const saved = await page.evaluate(id => window.zhivex.personalState(id), id);
    assert.equal((await page.evaluate(id => window.zhivex.notes(id, {}), id)).notes[0].title, 'Desktop fixture note');
    assert.equal(saved.tasks[0].title, 'Desktop fixture task'); assert.equal(saved.reminders[0].text, 'Desktop fixture reminder'); assert.equal(saved.reminders[0].status, 'pending');
    await page.getByRole('button', {name: 'Notes', exact: true}).click();
    await page.getByRole('button', {name: 'Read note', exact: true}).click();
    await page.getByRole('button', {name: 'Ask to delete note', exact: true}).click();
    await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('button', {name: 'Approve this action', exact: true}).waitFor();
    assert.equal((await page.evaluate(id => window.zhivex.notes(id, {}), id)).total, 1);
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await waitForAsync(() => page.evaluate(async id => (await window.zhivex.notes(id, {})).total === 0, id));
    await page.getByRole('button', {name: 'Notes', exact: true}).click();
    await page.getByText('No saved notes on this page.', {exact: true}).waitFor();
    await page.getByRole('button', {name: 'Decision history', exact: true}).click();
    const history = page.getByRole('region', {name: 'Decision history', exact: true});
    await history.getByText('daily_write_delete_note', {exact: true}).waitFor();
    const sessionDoc = await page.evaluate(async () => {
      const list = await window.zhivex.command('assistant', {method: 'session.list'});
      return list.data.sessions[0];
    });
    await history.getByLabel('Execution history', {exact: true}).selectOption(sessionDoc.runs[1].runId);
    await history.getByText('daily_write_create_task', {exact: true}).waitFor();
    assert.equal(await history.getByText('daily_write_delete_note', {exact: true}).count(), 0);
    await history.getByRole('button', {name: 'Refresh history', exact: true}).click();
    await history.getByText('daily_write_create_task', {exact: true}).waitFor();
    await history.getByLabel('Execution history', {exact: true}).selectOption(sessionDoc.runs[0].runId);
    await history.getByText('No recorded decisions on this page.', {exact: true}).waitFor();
    await history.getByLabel('Execution history', {exact: true}).selectOption(sessionDoc.runs[1].runId);
    await history.getByText('daily_write_create_task', {exact: true}).waitFor();
    await page.screenshot({path: path.join(directory, 'decision-history.png')});
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 390, height: 900}));
    await page.waitForFunction(() => innerWidth <= 390);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: path.join(directory, 'decision-history-compact.png')});
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width: 1440, height: 960}));
    await page.waitForFunction(() => innerWidth >= 1400);


    await page.getByRole('button', {name: 'Workspace', exact: true}).click();

  }
  if (recoverNodeHost) {
    // Kill the external owner, keeping Electron and its utility process alive.
    const workerPid = await desktop.evaluate(({app}) => app.getAppMetrics().find(value => value.name === 'Zhivex Assistant')?.pid);
    await new Promise(resolve => { nodeService.once('exit', resolve); nodeService.kill('SIGKILL'); });
    if (autoRecoverNodeHost) {
      await waitForAsync(() => page.evaluate(async () => {try {return (await window.zhivex.command('assistant', {method: 'session.list'})).ok === true;} catch {return false;}}));
    } else {
    await page.getByRole('button', {name: 'Assistant settings', exact: true}).click();
    await page.getByRole('button', {name: 'Retry startup', exact: true}).click();
    await page.getByRole('button', {name: 'Back to chat', exact: true}).click();
    }
    await page.getByText('Autonomous assistant is ready.', {exact: true}).first().waitFor();
    assert.equal(await desktop.evaluate(({app}) => app.getAppMetrics().find(value => value.name === 'Zhivex Assistant')?.pid), workerPid);
    assert.equal((await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).data.sessions.length, 1);
    if (testCode) assert.equal((await page.evaluate(() => window.zhivex.command('code', {method: 'session.list'}))).data.sessions.length, testTools ? 2 : 1);
    await page.screenshot({path: path.join(directory, 'external-owner-recovered.png')});
  }
  await desktop.evaluate(({ app }) => { const worker = app.getAppMetrics().find(value => value.name === 'Zhivex Assistant'); if (!worker) throw new Error('WORKER_MISSING'); process.kill(worker.pid, 'SIGKILL'); });
  await page.getByRole('button', { name: 'Assistant settings', exact: true }).click();
  await page.getByRole('button', { name: 'Retry startup', exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.getByText('Autonomous assistant is ready.', { exact: true }).first().waitFor();
  assert.equal((await page.evaluate(() => window.zhivex.command('assistant', { method: 'session.list' }))).data.sessions.length, 1);
  if (testCode) {
    await page.getByRole('button', {name: 'Code', exact: true}).click();
    if (testTools) await page.locator('.session-list').getByRole('button', {name: 'New conversation', exact: true}).click();
    await page.getByText('code-edit: update review.txt', {exact: true}).waitFor();
    assert.equal((await page.evaluate(() => window.zhivex.codeState())).projects.length, 2);
    assert.equal((await page.evaluate(() => window.zhivex.command('code', {method: 'session.list'}))).data.sessions.length, testTools ? 2 : 1);
    assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
  }

  await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false}); });
  await desktop.close(); desktop = undefined;
  if (recoverNodeHost) await assert.rejects(readFile(path.join(directory, 'coordinator.json')), {code: 'ENOENT'});
  assert.deepEqual(errors, []);
  const report = { passed: true, ...(measureBaseline ? {baseline} : {}), packaged, nodeHost, recoverNodeHost, autoRecoverNodeHost, testPersonal, testCode, testTools, testGit, directory, profile, checks: [...(recoverNodeHost ? ['external owner crash recovered in the same Electron worker without duplicate sessions'] : []), ...(testPersonal ? ['personal tasks and reminders are read from core', 'notes require approval and support safe text, search and restart', 'history reads earlier run decisions after restart and distinguishes empty runs', 'installed Node CLI reads the same saved note as Electron', 'Today shows persisted tasks and reminders without a calendar connection', 'task and reminder require approval before effects', 'personal state survives quit and restart', 'installed Node CLI reads the same reviewed task and reminder as Electron'] : []), nodeHost ? 'discovered independent Node host' : 'cold start without service', 'native keychain onboarding', 'real core session and streaming run', 'renderer isolation', 'compact navigation keyboard focus trap, Escape, search shortcut and focus restoration', 'close preserves host', 'shared native status menu shows and hides the existing window', ...(!nodeHost ? ['status menu quit uses coordinated shutdown'] : []), ...(nodeHost ? ['Electron quit preserves independent Node host'] : ['quit releases host', 'cancel quit keeps the service available', 'quit dialog explains pending work and disconnected clients']), 'restart preserves profile and conversation', 'GUI-style initial PATH; app runtime is bundled', 'worker crash recovery without duplicate conversations', 'setup state excludes API keys', ...(testCode ? ['non-Git folder rejected without registering project or disconnecting Assistant', 'autonomous Code and Assistant simultaneously', 'native folder selection', 'isolated project sessions', 'reviewed file edit', 'busy project refuses switch', 'both areas survive restart and worker crash', 'project navigation and conversation selection restore with isolated unsent drafts'] : []), ...(testTools ? ['installed Node CLI and Electron read identical project context', 'checkpoint capture and reviewed restoration', 'raw restoration rejected', 'real Bun check execution after review', 'worktree create open and reviewed removal', 'source checkout preserved'] : []), ...(testGit ? ['staging and reviewed local commit', 'no commit before authorization', 'exact selected content committed once'] : [])], errors };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (failure) {
  if (desktop) { const page = await desktop.firstWindow(); console.error(await page.locator('body').innerText()); await page.screenshot({path: path.join(directory, 'failure.png')}); }
  throw failure;
} finally {
  clearTimeout(deadline);
  await desktop?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false}); }).catch(() => {});
  await desktop?.close().catch(() => desktop?.process().kill('SIGKILL'));
  await writeFile(path.join(directory, 'runtime.log'), logs.join(''));
  if (nodeService && nodeService.exitCode === null && nodeService.signalCode === null) {
    await new Promise(resolve => {const timer = setTimeout(() => nodeService.kill('SIGKILL'), 10000); nodeService.once('exit', () => {clearTimeout(timer); resolve();}); nodeService.kill('SIGTERM');});
  }
  await entry.deleteCredential().catch(() => {}); server.close();
  console.log(`Artifacts: ${directory}`);
}
