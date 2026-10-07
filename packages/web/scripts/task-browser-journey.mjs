import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const [codeArg, outputArg] = process.argv.slice(2);
assert(codeArg && outputArg, 'Pass exact Code package directory and output directory');
const code = path.resolve(codeArg), output = path.resolve(outputArg);
await mkdir(output, { recursive: true });
const root = await mkdtemp('/tmp/code05-web-'), workspace = root + '/atlas', other = root + '/beacon';
await mkdir(workspace); await mkdir(other); await mkdir(root + '/bin'); await mkdir(root + '/tmp');
const fixtures = {
  'greeting.mjs': 'export const greeting = name => `Hello, ${name}!`;\n',
  'effects.log': '',
  'check.mjs': "import assert from 'node:assert/strict'; import {appendFileSync,existsSync} from 'node:fs'; import {greeting} from './greeting.mjs'; if(existsSync('inject-effect')) appendFileSync('effects.log','effect\\n'); assert.equal(greeting('Ada'),'Hello, Ada!');\n",
  'package.json': JSON.stringify({ private: true, type: 'module', packageManager: 'npm@11.0.0', scripts: { test: 'node check.mjs' } }) + '\n'
};
const fixtureSha256 = createHash('sha256').update(JSON.stringify(fixtures)).digest('hex');
assert.equal(fixtureSha256, '473a9e2144b0042b1b46ef54f915de693045df89d6175bde42a3393d2b083263');
for (const [name, content] of Object.entries(fixtures)) await writeFile(workspace + '/' + name, content);
await writeFile(workspace + '/.gitignore', '.zhivex-harness/\n');
for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Frozen baseline']]) {
  const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
}
const pairingFile = root + '/pairing';
const opener = root + '/bin/' + (process.platform === 'darwin' ? 'open' : 'xdg-open');
await writeFile(opener, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' + JSON.stringify(pairingFile) + ',process.argv[2],{mode:384});\n'); await chmod(opener, 0o755);
const preload = fileURLToPath(new URL('./task-offline-provider.mjs', import.meta.url));
let child, logs = '', browser;
const scenarios = [], screenshots = [], errors = [];
const requests = async () => (await readFile(root + '/requests.jsonl', 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
async function launch() {
  await rm(pairingFile, { force: true });
  child = spawn(process.execPath, [code + '/dist/cli.js', 'web', '--workspace', workspace, '--workspace', other, '--provider', 'openai', '--model', 'gpt-5.6-luna'], {
    env: { PATH: root + '/bin:' + process.env.PATH, HOME: root, TMPDIR: root + '/tmp', CI: '1', NODE_NO_WARNINGS: '1',
      OPENAI_API_KEY: 'sk-offline-code05-never-sent', ZHIVEX_HARNESS_CONFIG_DIR: root + '/config', ZHIVEX_HARNESS_CREDENTIAL_STORE: 'disabled',
      NODE_OPTIONS: '--import=' + preload, CODE_TASK_FIXTURE_ROOT: root, CODE_TASK_FIXTURE_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  for (let i = 0; i < 200; i++) {
    const url = await readFile(pairingFile, 'utf8').catch(() => '');
    if (url) return url;
    if (child.exitCode !== null) throw Error('LAUNCH_FAILED ' + logs);
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('PAIRING_TIMEOUT ' + logs);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); child = undefined; }
}
try {
  const url = await launch();
  browser = await chromium.launch({ headless: true, ...(process.env.WEB_BROWSER_PATH ? { executablePath: process.env.WEB_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const traced = new WeakMap(); let traceId = 0;
  page.on('request', request => {
    if (!request.url().endsWith('/api/action')) return;
    const body = request.postDataJSON(), id = ++traceId; traced.set(request, id);
    appendFileSync(output + '/command-trace.jsonl', JSON.stringify({ id, at: Date.now(), phase: 'request', action: body.action,
      sessionId: body.sessionId, runId: body.runId, expectedRevision: body.expectedRevision }) + '\n');
  });
  page.on('response', async response => {
    const id = traced.get(response.request()); if (!id) return;
    try {
      const value = await response.json(), data = value.data, task = data?.projection?.task;
      appendFileSync(output + '/command-trace.jsonl', JSON.stringify({ id, at: Date.now(), phase: 'response', status: response.status(),
        ok: value.ok, error: value.error?.code, kind: data?.kind,
        run: data?.run && { id: data.run.runId, revision: data.run.revision, status: data.run.status },
        session: data?.session && { id: data.session.sessionId, revision: data.session.revision, runs: data.session.runs?.map(r => ({ id: r.runId, status: r.status })) },
        task: task && { reference: task.reference, revision: task.runRevision, execution: task.execution, reasons: task.reasons, budget: task.budget } }) + '\n');
    } catch { /* A deliberately lost response has no authority; retain its request row. */ }
  });
  const capture = async name => { await page.screenshot({ path: output + '/' + name + '.png', fullPage: true }); screenshots.push(name + '.png'); };
  await page.goto(url); await page.getByRole('button', { name: 'Create a session', exact: true }).click();
  await page.getByRole('button', { name: 'Define task', exact: true }).click();
  await page.getByLabel('Objective', { exact: true }).fill('Review greeting behavior without changing its output');
  await page.getByLabel('Exact editable files, one per line').fill('greeting.mjs\neffects.log');
  await page.getByLabel('Input tokens', { exact: true }).fill('60000');
  await page.getByLabel('Output tokens', { exact: true }).fill('8192');
  await page.getByLabel('Total tokens', { exact: true }).fill('68192');
  await capture('task-definition-desktop');
  await page.getByRole('button', { name: 'Start governed task', exact: true }).click();
  async function approve() {
    await page.getByRole('button', { name: 'Review proposed operation', exact: true }).first().click();
    await page.getByRole('button', { name: /^Approve/ }).click();
  }
  // Existing exact-review controls retain their original labels and authority.
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'waiting approval');
  await capture('task-pending-desktop');
  await approve();
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'waiting approval');
  await approve();
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'completed');
  await page.getByText('Checks: verified for these bytes', { exact: true }).waitFor();
  const beforeReview = await requests();
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('heading', { name: 'Review exact delivery', exact: true }).waitFor();
  assert.equal(await page.locator('.task-confirmation img').count(), 0);
  assert((await page.getByLabel('Task delivery diff').innerText()).includes('<img onerror=alert(1)>'));
  await capture('task-review-desktop');
  await page.getByLabel('I reviewed the diff and all human requirements for this snapshot.').check();
  await page.getByRole('button', { name: 'Accept this snapshot', exact: true }).click();
  await page.getByText('Human acceptance: recorded for this snapshot', { exact: true }).waitFor();
  assert.equal(await requests(), beforeReview);
  scenarios.push({ id: 'normal-task-review-accept', status: 'passed', humanParticipant: false, scriptedOperatorAcknowledgement: true, modelRequestsDuringReview: 0 });
  await page.setViewportSize({ width: 390, height: 844 }); await capture('task-mobile');
  await page.getByText('Task budget and continuation', { exact: true }).click();
  await capture('task-budget-mobile');
  await page.getByText('Task budget and continuation', { exact: true }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload(); await page.getByText('Human acceptance: recorded for this snapshot', { exact: true }).waitFor();
  assert.equal(await requests(), beforeReview);
  scenarios.push({ id: 'reload-without-replay', status: 'passed', modelRequests: 0 });
  // Two real tabs share the paired host but must not retain stale review authority.
  const peer = await context.newPage();
  await peer.addInitScript(csrf => globalThis.sessionStorage.setItem('zhivex-web-csrf', csrf), await page.evaluate(() => globalThis.sessionStorage.getItem('zhivex-web-csrf')));
  await peer.goto(new URL(url).origin);
  await peer.locator('.session-row').first().click();
  await peer.getByRole('button', { name: 'Review task', exact: true }).click();
  await peer.getByLabel('I reviewed the diff and all human requirements for this snapshot.').check();
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('button', { name: 'Correct requirements', exact: true }).click();
  await page.getByLabel('Additional requirement', { exact: true }).fill('Keep the exact greeting output');
  await page.getByRole('button', { name: 'Back to review', exact: true }).click();
  assert.equal(await requests(), beforeReview);
  await page.getByRole('button', { name: 'Correct requirements', exact: true }).click();
  await page.getByLabel('Additional requirement', { exact: true }).fill('Keep the exact greeting output');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await page.getByText('Revision 2', { exact: true }).waitFor();
  await peer.getByText('This review changed, expired or disconnected. Close it and read a fresh review.', { exact: true }).waitFor();
  assert.equal(await peer.getByRole('button', { name: 'Accept this snapshot', exact: true }).isEnabled(), false);
  assert.equal(await requests(), beforeReview);
  scenarios.push({ id: 'two-tabs-obsolete-review-and-edit-back', status: 'passed', modelRequests: 0 });
  await peer.close();
  // Back/Escape does not dispatch continuation; double-click dispatches only once.
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  await page.getByLabel('Continuation instruction', { exact: true }).fill('Verify the corrected requirement');
  await page.keyboard.press('Escape');
  assert.equal(await requests(), beforeReview);
  assert.equal(await page.getByRole('button', { name: 'Review task', exact: true }).evaluate(e => e === document.activeElement), true);
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  await page.getByLabel('Continuation instruction', { exact: true }).fill('Verify the corrected requirement');
  let continuations = 0;
  page.on('request', request => { if (request.url().endsWith('/api/action') && request.postDataJSON()?.action === 'taskContinue') continuations++; });
  await page.getByRole('button', { name: 'Confirm continuation', exact: true }).evaluate(e => { e.click(); e.click(); });
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'waiting approval');
  await approve();
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'completed');
  assert.equal(continuations, 1);
  await page.getByText('Checks: verified for these bytes', { exact: true }).waitFor();
  scenarios.push({ id: 'corrected-task-explicit-continuation-double-click', status: 'passed', continuationCommands: continuations });
  const afterContinuation = await requests();
  await page.getByLabel('WORKSPACE', { exact: true }).selectOption({ label: 'beacon' });
  await page.waitForFunction(() => !document.querySelector('#task-evidence .count')); 
  assert.equal(await page.getByText('Revision 2', { exact: true }).count(), 0);
  await page.getByLabel('WORKSPACE', { exact: true }).selectOption({ label: 'atlas' });
  await page.locator('.session-row').first().click();
  await page.getByText('Revision 2', { exact: true }).waitFor();
  assert.equal(await requests(), afterContinuation);
  scenarios.push({ id: 'workspace-switch-without-stale-evidence-or-replay', status: 'passed', modelRequests: 0 });
  // Fresh task has a clean baseline. Only the synthetic transport waits and emits no usage.
  for (const args of [['add', 'greeting.mjs'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Reviewed fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: workspace }).status, 0);
  }
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByRole('button', { name: 'Define task', exact: true }).click();
  await page.getByLabel('Objective', { exact: true }).fill('slow-cancel preserve the original accounting');
  await page.getByLabel('Exact editable files, one per line').fill('greeting.mjs\neffects.log');
  await page.getByLabel('Input tokens', { exact: true }).fill('60000');
  await page.getByLabel('Output tokens', { exact: true }).fill('8192');
  await page.getByLabel('Total tokens', { exact: true }).fill('68192');
  await page.getByRole('button', { name: 'Start governed task', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'running');
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await page.waitForFunction(() => ['cancelled', 'Reconciliation required'].includes(document.querySelector('.pill')?.textContent));
  if (await page.getByRole('alert').count()) await page.getByRole('button', { name: 'Reconnect' }).click();
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'cancelled');
  await page.getByText('Host recorded cancellation. Provider stop remains unconfirmed; prior effects are retained.', { exact: true }).waitFor();
  await page.getByText('Task budget and continuation', { exact: true }).click();
  await page.getByText(/Cost is incomplete/).waitFor();
  await capture('task-cancelled-unknown-desktop');
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Continue task', exact: true }).isEnabled(), false);
  const afterCancel = await requests();
  await page.reload();
  await page.getByText('Host recorded cancellation. Provider stop remains unconfirmed; prior effects are retained.', { exact: true }).waitFor();
  assert.equal(await requests(), afterCancel);
  scenarios.push({ id: 'slow-cancel-unknown-usage-blocks-continuation', status: 'passed', providerStopped: 'unconfirmed', modelRequestsAfterReload: 0 });
  await stop();
  const restartedUrl = await launch();
  await page.goto(restartedUrl);
  await page.locator('.session-row').first().click();
  await page.getByText('Host recorded cancellation. Provider stop remains unconfirmed; prior effects are retained.', { exact: true }).waitFor();
  assert.equal(await requests(), afterCancel);
  await capture('task-restart-handoff-desktop');
  scenarios.push({ id: 'process-restart-handoff-without-transcript-or-replay', status: 'passed', modelRequests: 0, humanMinutes: null });
  assert.equal(await readFile(workspace + '/effects.log', 'utf8'), '');
  assert.deepEqual(errors, []);
  await stop();
  await writeFile(output + '/report.json', JSON.stringify({ status: 'passed', fixtureSha256, scenarios, screenshots, liveProvider: false, externalPilot: false, modelRequests: await requests() }, null, 2) + '\n');
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: output + '/failure-screen.png', fullPage: true }).catch(() => {});
    await writeFile(output + '/failure-screen.txt', await page.locator('body').innerText()).catch(() => {});
  }
  await writeFile(output + '/failure.json', JSON.stringify({ status: 'failed', message: String(error), scenarios, screenshots, fixtureSha256 }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); await stop();
  for (const name of ['requests.jsonl', 'transport-events.jsonl']) {
    const content = await readFile(root + '/' + name).catch(() => undefined);
    if (content) await writeFile(output + '/' + name, content);
  }
  await writeFile(output + '/launcher.log', logs.replaceAll(root, '[FIXTURE_ROOT]').replaceAll('sk-offline-code05-never-sent', '[REDACTED]'));
  await rm(root, { recursive: true, force: true });
}
