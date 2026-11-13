import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../src-tauri/runtime', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'assistant-desktop-smoke-'));
const start = () => spawn(path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'), [path.join(runtime, 'dist/desktop.js')], {
  cwd: runtime, env: { ...process.env, ASSISTANT_DESKTOP_DIRECTORY: directory, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); process.exit(1); }, 45000);
let child: ReturnType<typeof start> | undefined;
try {
  for (let pass = 0; pass < 2; pass++) {
    child = start();
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const ready = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error('Host exited before readiness'); })]);
    const url = new URL(JSON.parse(String(ready[0])).url);
    assert.equal(url.hostname, '127.0.0.1');
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(url.origin + '/api/setup')).status, 401);
    const setup = await fetch(url.origin + '/api/setup', { headers });
    assert.equal(setup.status, 200);
    assert.equal((await setup.json() as { ready: boolean }).ready, false);
    assert.match(await (await fetch(url.origin)).text(), /<html/);
    const duplicate = start();
    let duplicateOutput = ''; duplicate.stdout.on('data', data => { duplicateOutput += String(data); });
    assert.equal((await once(duplicate, 'exit'))[0], 1);
    assert.equal(duplicateOutput, '');
    // Both graceful shutdown and owner-pipe EOF must release the lock and port.
    if (pass === 0) child.stdin.write('stop\n'); else child.stdin.end();
    assert.equal((await exited)[0], 0);
    lines.close();
    await assert.rejects(fetch(url.origin + '/api/setup', { headers }));
    child = undefined;
  }
  console.log('Desktop smoke passed: bundled runtime/assets, bearer authentication, duplicate lock, shutdown, restart and parent EOF.');
} finally {
  child?.kill(); clearTimeout(timeout); await rm(directory, { recursive: true, force: true });
}
