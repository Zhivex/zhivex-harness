import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = await mkdtemp('/tmp/zhx-unified-');
const workspace = path.join(output, 'repo'); await mkdir(workspace);
await writeFile(path.join(workspace, 'review.txt'), 'before\n');
const environment = { PATH: process.env.PATH, HOME: output };
const {connectApplication} = await import('@zhivex-ai/harness/application/client');
let hostProcess, desktop, hostStderr = '';
const pages = [];
const runtimeLog = [], pageErrors = [];
async function boot() {
  hostStderr = '';
  hostProcess = spawn('node', [path.join(root, 'packages/desktop/scripts/unified-fixture-host.mjs'), workspace], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  hostProcess.stderr.on('data', chunk => { hostStderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HOST_TIMEOUT ${hostStderr}`)), 15000);
    let buffer = '';
    hostProcess.stdout.on('data', chunk => { buffer += chunk.toString(); if (buffer.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } } });
    hostProcess.once('error', error => { clearTimeout(timer); reject(error); });
    hostProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`HOST_EXIT ${code} ${hostStderr}`)); });
  });
}
async function stopHost() { if (!hostProcess || hostProcess.exitCode !== null) return; const stopped = once(hostProcess, 'exit'); hostProcess.kill('SIGTERM'); await stopped; }
async function cli(credentialsPath, args) {
  const process = spawn('node', [path.join(JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8')).install, 'node_modules/@zhivex-ai/harness/dist/cli.js'), ...args, '--service', credentialsPath], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; process.stdout.on('data', chunk => { stdout += chunk; }); process.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(process, 'exit'); assert.equal(code, 0, stderr); return JSON.parse(stdout);
}
async function open(credentialsPath) {
  desktop = await electron.launch({ executablePath: path.join(root, 'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [path.join(root, 'packages/desktop/build/unified-main.cjs'), '--service-file', credentialsPath, '--user-data', path.join(output, 'user-data')], env: environment, timeout: 20000 });
  desktop.process().stderr?.on("data", chunk => runtimeLog.push(chunk.toString()));
  desktop.on("console", message => runtimeLog.push(message.text()));
  const page = await desktop.firstWindow(); pages.push(page);
  page.on("console", message => { if (message.type() === "error") runtimeLog.push(message.text()); });
  page.on('pageerror', error => { pageErrors.push(error.message); });
  await page.waitForSelector('.unified-shell'); return page;
}
const started = Date.now();
const deadline = setTimeout(() => { desktop?.process().kill("SIGKILL"); hostProcess?.kill("SIGKILL"); }, 90000);
try {
  let ready = await boot();
  const waiting = await cli(ready.credentialsPath, ['run', '--json', 'shared-edit: update review.txt after my review']);
  assert.equal(waiting.status, 'waiting_approval');
  const listed = await cli(ready.credentialsPath, ['sessions', 'list', '--json']);
  const sessionId = listed.sessions[0].sessionId;
  let page = await open(ready.credentialsPath);
  await page.getByText('An action needs your review.').waitFor();
  await page.screenshot({ path: path.join(output, 'workspace-light.png') });
  await page.getByRole('button', { name: 'Review action', exact: true }).click();
  await page.getByText('review.txt', { exact: true }).waitFor();
  const approve = page.getByRole('button', { name: 'Approve this action', exact: true });
  assert.equal(await approve.isDisabled(), true);
  await page.getByRole('checkbox', { name: 'Viewed', exact: true }).check();
  await page.screenshot({ path: path.join(output, 'review-light.png') });
  await approve.click();
  await page.getByText('The reviewed change is saved. CLI and desktop share this result.', { exact: true }).waitFor();
  assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
  let inspected = await cli(ready.credentialsPath, ['sessions', 'inspect', sessionId, '--json']);
  assert.equal(inspected.session.runs.at(-1).status, 'completed');
  await page.getByRole('button', { name: 'Dark appearance' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft preserved across reload');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'Draft preserved across reload');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: path.join(output, 'workspace-dark.png') });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue this shared conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('This conversation is shared with the terminal.', { exact: true }).waitFor();
  inspected = await cli(ready.credentialsPath, ['sessions', 'inspect', sessionId, '--json']);
  assert.equal(inspected.session.runs.length, 2);
  assert.equal(inspected.session.runs.at(-1).status, 'completed');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('wait-for-cancel');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await page.getByText('Response stopped', {exact: true}).waitFor();
  const isolation = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: typeof window.zhivex.command }));
  assert.deepEqual(isolation, { require: 'undefined', process: 'undefined', bridge: 'function' });
  const denied = await page.evaluate(async () => {
    try { await window.zhivex.command('code', { method: 'approval.resolve' }); return false; } catch { return true; }
  }); assert.equal(denied, true);
  const activityClient = await connectApplication(ready.credentialsPath);
  const expired = await activityClient.events(sessionId, 0);
  assert.equal(expired.cursorExpired, true); assert(expired.snapshot);
  assert.deepEqual((await activityClient.events(sessionId, expired.nextCursor)).events, []);
  // Suspend the owner process without terminating its lease, then resume the same service.
  const identityBeforePause = await readFile(ready.credentialsPath, 'utf8');
  hostProcess.kill('SIGSTOP');
  try {
    await page.getByRole('textbox', {name: 'Message', exact: true}).fill('Draft survives owner suspension');
    assert.equal(await page.getByRole('textbox', {name: 'Message', exact: true}).inputValue(), 'Draft survives owner suspension');
  } finally {hostProcess.kill('SIGCONT');}
  assert.equal(await readFile(ready.credentialsPath, 'utf8'), identityBeforePause);
  assert.equal((await cli(ready.credentialsPath, ['sessions', 'inspect', sessionId, '--json'])).session.runs.length, 3);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await writeFile(path.join(workspace, 'advance-automation'), 'advance');
  const automationDeadline = Date.now() + 5000;
  let automation;
  while (!automation?.enqueued) {
    automation = await readFile(path.join(workspace, 'automation-result.json'), 'utf8').then(JSON.parse, () => null);
    if (Date.now() > automationDeadline) throw new Error('HIDDEN_AUTOMATION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(automation.enqueued, 1);
  assert.equal((await cli(ready.credentialsPath, ['sessions', 'list', '--json'])).sessions.length, 1);
  const background = await cli(ready.credentialsPath, ['run', '--json', 'Background task while the window is hidden']);
  assert.equal(background.status, 'completed');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 844));
  await page.screenshot({ path: path.join(output, 'workspace-compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await stopHost();
  await page.getByRole("alert").filter({hasText: "workspace connection was interrupted"}).waitFor();
  ready = await boot();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("alert").filter({hasText: "workspace connection was interrupted"}).waitFor({state: "hidden"});
  await page.getByText('Connected', {exact: true}).waitFor();
  await desktop.close(); desktop = undefined;
  page = await open(ready.credentialsPath);
  await page.getByText('This conversation is shared with the terminal.', { exact: true }).waitFor();
  assert.equal((await cli(ready.credentialsPath, ['sessions', 'inspect', sessionId, '--json'])).session.runs.length, 3);
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ schemaVersion: 1, pass: true, elapsedMs: Date.now() - started,
    realNodeHost: true, realElectron: true, fixtureModel: true, cliToDesktop: true, desktopToCli: true,
    reviewedFileEffect: true, persistedAfterRestart: true, draftAfterReload: true, isolatedRenderer: true,
    closeKeepsHost: true, hiddenWindowAutomationEnqueuesOnce: true, hiddenWindowTaskCompletes: true, ownerSuspendResume: true, expiredCursorReconciles: true, cancellationDuringSubmission: true, reconnectAfterHostRestart: true, compactNoDocumentOverflow: true }, null, 2));
  console.log(JSON.stringify({ pass: true, evidenceDirectory: output }));
} catch (error) {
  if (pages.at(-1) && !pages.at(-1).isClosed()) await pages.at(-1).screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${output}\n${hostStderr}`); throw error;
} finally { clearTimeout(deadline); if (desktop) await desktop.close(); await stopHost(); await writeFile(path.join(output, "runtime.log"), runtimeLog.join("\n")); }
