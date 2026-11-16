import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { Workspace } from '../packages/core/src/workspace/workspace.js';

test('approved local checks propagate cancellation to the spawned process tree', async () => {
  const root = await mkdtemp('/tmp/code-cancel-');
  const workspace = await Workspace.open(root);
  const script = `bun -e "require('node:fs').writeFileSync('child.pid', String(process.pid)); setInterval(()=>{},1000)"`;
  const controller = new AbortController();
  try {
    await writeFile(root + '/package.json', JSON.stringify({packageManager: 'bun@1.4.3', scripts: {test: script}}));
    const running = workspace.runCheck('test', script, ['test'], controller.signal);
    const outcome = running.then(() => 'completed', error => error.message);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) { try { pid = Number(await readFile(root + '/child.pid', 'utf8')); } catch {} if (!pid) await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(pid).toBeGreaterThan(0);
    controller.abort(new Error('CANCEL_CHECK'));
    expect(await outcome).toBe('CANCEL_CHECK');
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { pid = 0; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(pid).toBe(0);
    await expect(workspace.runCheck('test', 'changed script', ['test'])).rejects.toThrow('expectedScript');
  } finally { controller.abort(); await rm(root, {recursive: true, force: true}); }
});
