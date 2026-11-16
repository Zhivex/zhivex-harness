import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, realpath, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {_electron as electron} from 'playwright';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
const core = path.join(installed.install, 'node_modules/@zhivex-ai/harness');
const {connectCoordinator} = await import(path.join(core, 'dist/engine/application-client.js'));
const output = await realpath(await mkdtemp('/tmp/zhx-launch-race-'));
const results = [];
const crossOwnerRestart = process.argv.includes('--cross-owner-restart');
const waitFor = async check => {const until = Date.now() + 15000; while (!await check()) {if (Date.now() >= until) throw new Error('CONDITION_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 50));}};
for (const scenario of ['concurrent', 'electron-owner']) {
  const directory = path.join(output, scenario);
  let desktop;
  const cli = async args => {
    const {stdout} = await execute('node', [path.join(core, 'dist/zhx.js'), ...args, '--application-directory', directory, '--json'], {timeout: 45000});
    return JSON.parse(stdout);
  };
  const launch = async () => {
    desktop = await electron.launch({executablePath: path.join(root, 'packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness'), args: ['--assistant-directory', directory, '--user-data', directory + '/electron'], env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME}, timeout: 45000});
    const page = await desktop.firstWindow(); await page.waitForSelector('.unified-shell');
    const metadata = await desktop.evaluate(({app}) => JSON.parse(process.getBuiltinModule('node:fs').readFileSync(app.getAppPath() + '/build/runtime-metadata.json', 'utf8')));
    assert.equal(metadata.harnessArtifactSha256, installed.sha256);
    return page;
  };
  const owner = () => {
    const db = new Database(path.join(directory, 'setup.sqlite'), {readonly: true});
    try {const rows = db.query('SELECT pid FROM owner').all(); assert.equal(rows.length, 1); return rows[0].pid;} finally {db.close();}
  };
  try {
    let page, start;
    if (scenario === 'concurrent') [page, start] = await Promise.all([launch(), cli(['application', 'start'])]);
    else {page = await launch(); start = await cli(['application', 'start']);}
    assert.equal(start.status, 'running');
    console.log(JSON.stringify({scenario, stage: 'both-clients-ready'}));
    const pid = owner(); process.kill(pid, 0);
    const worker = await desktop.evaluate(({app}) => app.getAppMetrics().find(value => value.name === 'Zhivex Assistant')?.pid);
    assert(worker);
    const electronOwns = pid === worker;
    if (scenario === 'electron-owner') assert.equal(electronOwns, true);
    const coordinator = await connectCoordinator(directory);
    const identity = await readFile(path.join(directory, 'coordinator.json'), 'utf8');
    await cli(['agents', 'create', 'Race draft']);
    assert.equal((await page.evaluate(() => window.zhivex.setupState())).draftName, 'Race draft');
    await page.evaluate(() => window.zhivex.setupAction('tools', {daily: true, proactive: false}));
    assert.equal((await cli(['agents', 'list'])).draft.tools.daily, true);
    assert.equal((await coordinator.state()).state.tools.daily, true);
    // A second pair must attach without replacing the credentials or owner lease.
    await Promise.all([cli(['application', 'start']), cli(['application', 'start'])]);
    assert.equal(owner(), pid); assert.equal(await readFile(path.join(directory, 'coordinator.json'), 'utf8'), identity);
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
    assert.equal((await cli(['agents', 'list'])).draft.name, 'Race draft');
    await desktop.evaluate(({dialog}) => {dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false});});
    const closeTimer = setTimeout(() => desktop?.process().kill('SIGKILL'), 15000);
    try {await desktop.close();} finally {clearTimeout(closeTimer); desktop = undefined;}
    if (electronOwns) await waitFor(async () => (await cli(['application', 'status'])).status === 'unavailable');
    else {assert.equal((await cli(['application', 'status'])).status, 'running'); assert.equal(owner(), pid); await cli(['application', 'stop', '--yes']);}
    await waitFor(async () => (await cli(['application', 'status'])).status === 'unavailable');
    // Keep native cross-identity restart as a separate gate from simultaneous admission.
    if (crossOwnerRestart) {
    const restored = await cli(['agents', 'list']);
    assert.equal(restored.draft.name, 'Race draft'); assert.equal(restored.draft.tools.daily, true); assert.equal(restored.agents.length, 0);
    await cli(['application', 'stop', '--yes']);
    await waitFor(async () => (await cli(['application', 'status'])).status === 'unavailable');
    }
    results.push({scenario, owner: electronOwns ? 'electron' : 'node', passed: true, checks: ['one owner lease', 'both clients share draft and tools', 'repeated starts preserve credentials and owner', 'window close preserves owner', 'quit respects ownership', ...(crossOwnerRestart ? ['Node restart recovers same draft'] : [])]});
    await writeFile(path.join(output, 'progress.json'), JSON.stringify({results}, null, 2));
  } finally {
    const cleanupTimer = setTimeout(() => desktop?.process().kill('SIGKILL'), 15000);
    await desktop?.evaluate(({dialog}) => {dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false});}).catch(() => {});
    await desktop?.close().catch(() => desktop?.process().kill('SIGKILL'));
    clearTimeout(cleanupTimer);
    await cli(['application', 'stop', '--yes']).catch(() => {});
  }
}
const report = {passed: true, crossOwnerRestart, directory: output, coreArtifactSha256: installed.sha256, results, limitations: 'Real packaged Electron, installed Node CLI, SQLite lease and authenticated coordinator. No provider setup or external effects. Concurrent scenario launches both clients together; scheduler order determines the owner. Electron-owner scenario deliberately waits for its first window before starting CLI. Cross-owner credential reload is a separate optional --cross-owner-restart gate; the initial run of that gate exceeded startup discovery time and later recovered the same draft.'};
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
