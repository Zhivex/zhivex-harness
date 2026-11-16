import { execFileSync, execFile, spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {promisify} from 'node:util';
import {startApplicationCoordinator} from '@zhivex-ai/harness/application';
import {connectCoordinator, connectApplication} from '@zhivex-ai/harness/application/client';
const execAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await realpath(await mkdtemp('/tmp/zhx-phase5-'));
const testTools = true, testCode = true, testGit = true, testPersonal = false;
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
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text), answer = 'Autonomous assistant is ready.';
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const userIndex = body.messages.findLastIndex(message => message.role === 'user');
    const content = body.messages[userIndex]?.content;
    const promptText = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
    if (promptText.includes('hold-code')) {res.write('data: '+JSON.stringify({id:'hold',choices:[{index:0,delta:{content:'Still running.'},finish_reason:null}]})+'\n\n'); return;}
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
let stored = null, owner, desktop, page; const errors = [];
const options = {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}};
async function waitForAsync(check) {const end = Date.now()+30000; while (!await check()) {if(Date.now()>end) throw new Error('CONDITION_TIMEOUT'); await new Promise(resolve=>setTimeout(resolve,60));}}
const openCodeTool = async name => {
 const menu = page.locator('details.sidebar-tools');
 if (!await menu.evaluate(element => element.open)) await menu.locator('summary').click();
 await menu.getByRole('button', {name, exact:true}).click();
};
const open = async () => {
 const packaged = process.argv.includes('--packaged');
 const appPathAt = process.argv.indexOf('--app-path');
 const appPath = appPathAt < 0 ? path.join(root,'packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app') : process.argv[appPathAt + 1];
 if (!appPath || !path.isAbsolute(appPath)) throw new Error('ABSOLUTE_APP_PATH_REQUIRED');
 desktop = await electron.launch({executablePath:packaged ? path.join(appPath,'Contents/MacOS/Zhivex Harness') : path.join(root,'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[...(packaged ? [] : [path.join(root,'packages/desktop/build/unified-main.cjs')]),'--assistant-directory',directory,'--user-data',directory+'/electron'],env:{...process.env,ZHIVEX_HARNESS_CREDENTIAL_STORE:'disabled'}});
 page = await desktop.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror',error=>errors.push(error.message));
};
try {
 owner = await startApplicationCoordinator(directory,options);
 let coordinator = await connectCoordinator(directory);
 await coordinator.call('action',{name:'begin',value:{name:'Phase five'}});
 await coordinator.call('action',{name:'provider',value:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,allowInsecureLocalhost:true,model:'test-model',apiKey:'offline-test-key'}});
 await coordinator.call('action',{name:'start',value:{}});
 const firstAgent=(await coordinator.catalog()).agents.find(agent=>agent.active).id;
 await coordinator.call('action',{name:'begin',value:{name:'Alternative model'}});
 await coordinator.call('action',{name:'provider',value:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,allowInsecureLocalhost:true,model:'second-model',apiKey:'second-offline-key'}});
 await coordinator.call('action',{name:'start',value:{}});
 await coordinator.call('action',{name:'select',value:{id:firstAgent}});
 await open();
 await page.getByRole('button',{name:/^New conversation/}).first().click();
 await page.getByRole('button',{name:'Rename conversation',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Start with an idea.',exact:true}).waitFor();
 await page.getByLabel('Message',{exact:true}).fill('Hello from the autonomous app');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByText('Autonomous assistant is ready.',{exact:true}).first().waitFor();
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
    await page.getByRole('button',{name:'Rename conversation',exact:true}).waitFor();
    await page.getByRole('heading',{name:'Start with an idea.',exact:true}).waitFor();
    await page.getByLabel('Message', {exact: true}).fill('code-edit: update review.txt');
    await page.getByRole('button', {name: 'Send message', exact: true}).click();
    await page.getByText('An action needs your review.', {exact: true}).waitFor();
    assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'before\n');
    // A new conversation must not hide pending decisions in another conversation.
    const pendingTitle = await page.locator('.session-list .selected').getAttribute('title');
    await page.getByRole('button', {name: /^New conversation/}).first().click();
    await page.getByRole('button',{name:'Rename conversation',exact:true}).waitFor();
    await page.getByRole('heading',{name:'Start with an idea.',exact:true}).waitFor();
    await page.locator('nav').getByRole('button',{name:/^Changes/}).click();
    await page.getByRole('region',{name:'Other conversations awaiting review'}).getByRole('button',{name:pendingTitle.trim(),exact:true}).click();
    await page.getByRole('checkbox',{name:'Viewed',exact:true}).waitFor();
    await page.locator('nav').getByRole('button',{name:'Workspace',exact:true}).click();
    // A pending review must prevent project switching, without interrupting Assistant.
    await page.getByRole('button', {name: 'Code projects', exact: true}).click();
    await desktop.evaluate(({dialog}, folder) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]}); }, secondWorkspace);
    await page.getByRole('button', {name: 'Choose project folder', exact: true}).click();
    await page.getByRole('alert').filter({hasText: 'CODE_PROJECT_BUSY'}).waitFor();
    assert.equal((await page.evaluate(() => window.zhivex.command('assistant', {method: 'session.list'}))).data.sessions.length, 1);
    await page.getByRole('button', {name: 'Back to Code', exact: true}).click();
    await page.getByRole('button', {name: 'Review action', exact: true}).click();
    if (await page.getByRole('button', {name: 'Load review', exact: true}).count()) await page.getByRole('button', {name: 'Load review', exact: true}).click();
    await page.getByRole('checkbox', {name: 'Viewed', exact: true}).check();
    await page.screenshot({path: path.join(directory, 'code-review.png')});
    for (const width of [1280,390]) {
      await desktop.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width,width===1280?720:844),width);
      await page.waitForFunction(width=>innerWidth===width,width);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(directory,`code-review-${width}.png`)});
    }
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,960));
    await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
    await page.locator('nav').getByRole('button', {name: 'Workspace', exact: true}).click();
    await page.getByText('Autonomous assistant is ready.', {exact: true}).first().waitFor();
    assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
    if (testTools) {
      await openCodeTool('Context');
      await page.getByRole('region', {name: 'Code context', exact: true}).getByText('AGENTS.md', {exact: true}).waitFor();
      await page.getByRole('button', {name: 'Refresh context', exact: true}).click();
      await page.getByText('No project skills indexed.', {exact: true}).waitFor();
      const context = await page.evaluate(async () => {const hosts = await window.zhivex.hosts(); return window.zhivex.codeContext(hosts.find(host => host.area === 'code').projectId);});
      assert.equal(await page.evaluate(async () => {try {await window.zhivex.codeContext('wrong-project'); return false;} catch {return true;}}), true);
      assert.equal(context.sources[0].path, 'AGENTS.md'); assert(!JSON.stringify(context).includes('Use Bun for project checks.'));
      const contextInstall = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
      const contextCli = JSON.parse((await execAsync('node', [path.join(contextInstall.install, 'node_modules/@zhivex-ai/harness/dist/zhx.js'), 'projects', 'context', '--application-directory', directory, '--json'], {encoding: 'utf8', timeout: 15000})).stdout);
      const {kind: contextKind, projectId: contextProject, ...cliContext} = contextCli;
      assert.equal(contextKind, 'application-code-context'); assert(contextProject); assert.deepEqual(cliContext, context);
      await page.screenshot({path: path.join(directory, 'code-context.png')});
      await openCodeTool('Checkpoints');
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
      await openCodeTool('Execution');
      await page.getByRole('button', {name: 'Reload checks', exact: true}).click();
      await page.getByRole('button', {name: 'Ask Code to run test', exact: true}).click();
      await page.getByRole('button', {name: 'Review execution', exact: true}).click();
      if (await page.getByRole('button', {name: 'Load review', exact: true}).count()) await page.getByRole('button', {name: 'Load review', exact: true}).click();
      await page.getByRole('button', {name: 'Approve this action', exact: true}).click();
      await page.locator('nav').getByRole('button', {name: 'Workspace', exact: true}).click();
      await page.getByText('Response complete', {exact: true}).waitFor();
      assert.equal(await readFile(path.join(workspace, 'check-ran.txt'), 'utf8'), 'ok');
      await openCodeTool('Execution');
      await page.getByRole('region', {name: 'Recorded check results', exact: true}).getByText('Exit code: 0', {exact: true}).waitFor();
      await page.getByText('Check passed.', {exact: true}).waitFor();
      await page.screenshot({path: path.join(directory, 'execution-result.png')});
      await openCodeTool('Worktrees');
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
      await openCodeTool('Worktrees');
      await page.getByRole('button', {name: 'Back to source project', exact: true}).click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Worktrees"]'));
      await openCodeTool('Worktrees');
      await page.getByRole('button', {name: 'Review removal', exact: true}).click();
      await page.getByLabel('I reviewed this checkout and its removal.').check();
      await page.getByRole('button', {name: 'Confirm removal', exact: true}).click();
      await waitForAsync(() => page.evaluate(async () => { try { return (await window.zhivex.worktrees())[0]?.status === 'removed'; } catch { return false; } }));
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Reload worktrees' && !button.disabled));
      assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'after\n');
      if (testGit) {
        const prior = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
        await openCodeTool('Git delivery');
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
  }
 await page.getByRole('button',{name:'Workspace',exact:true}).click();
 await page.getByLabel('Message',{exact:true}).fill('hold-code'); await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('button',{name:'Cancel task',exact:true}).waitFor();
 await page.getByRole('button',{name:'Assistant',exact:true}).click();
 await page.getByText('Hello from the autonomous app',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Code',exact:true}).click();
 await page.getByRole('button',{name:'Cancel task',exact:true}).click();
 await waitForAsync(async()=>!(await page.evaluate(()=>window.zhivex.command('code',{method:'session.list'}))).data.sessions.some(session=>session.runs.some(run=>['running','cancel_requested'].includes(run.status))));
 await page.getByRole('button',{name:'Code projects',exact:true}).click();
 const secondConnection=(await coordinator.catalog()).connections.find(connection=>connection.model==='second-model');
 await page.getByRole('combobox',{name:/Model connection/}).selectOption(secondConnection.id);
 await page.getByRole('button',{name:'Use selected connection for this project',exact:true}).click();
 await page.getByRole('region',{name:'Code projects',exact:true}).waitFor({state:'hidden'});
 await openCodeTool('Context');
 await page.getByRole('region',{name:'Code context'}).getByText(/second-model/).waitFor();
 await page.screenshot({path:directory+'/model-context.png'});
 const snapshot = await coordinator.state(), projectId = snapshot.code.active;
 await page.getByRole('button',{name:'Decision history',exact:true}).click();
 await page.screenshot({path:directory+'/history.png'});
 const crashed = desktop.process(); const exited = new Promise(resolve=>crashed.once('exit',resolve)); crashed.kill('SIGKILL'); await exited; desktop = undefined;
 assert.equal((await coordinator.state()).code.ready,true);
 await owner.close(); owner = await startApplicationCoordinator(directory,options);
 coordinator = await connectCoordinator(directory);
 assert.equal((await coordinator.state()).code.active,projectId);
 const code = await connectApplication((await coordinator.state()).codeCredentialsPath);
 assert((await code.command({method:'session.list'})).data.sessions.length >= 2);
 assert.equal(execFileSync('git',['-C',workspace,'rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'2');
 await open(); await page.getByRole('button',{name:'Code',exact:true}).click();
 await openCodeTool('Context');
 await page.getByRole('region',{name:'Code context'}).getByText('AGENTS.md',{exact:true}).waitFor();
 assert.equal(errors.length,0,JSON.stringify(errors));
 const report={passed:true,packaged:process.argv.includes("--packaged"),directory,coreArtifactSha256:JSON.parse(await readFile(root+'/packages/desktop/.harness/installed.json','utf8')).sha256,checks:['pending decisions remain discoverable after creating another conversation','repository validation and native picker','Assistant and Code coexist','pending file review prevents project switch','file effect only after review','CLI and Electron share context','checkpoint capture and approved restore','raw restore rejected','real Bun check after approval and visible result','worktree create/open/remove with source preservation','independently approved local commit once','area switch preserves running Code task; explicit cancellation stops it','model connection changes without losing conversations','Electron crash and host restart preserve sessions and commit'],limitations:['Local HTTP model and in-memory SecretStore; no keychain or external accounts. Push and PR transports validated separately with offline fixtures.']};
 await writeFile(directory+'/report.json',JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
} finally {if(page) await page.screenshot({path:directory+'/final.png'}).catch(()=>{}); await desktop?.close().catch(()=>{}); await owner?.close(); server.close(); console.log('Evidence: '+directory);}
