import { expect, test } from 'bun:test';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

test('candidate registry serves immutable bytes, rejects writes and bounds redirects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-registry-test-'));
  let child: ReturnType<typeof fork> | undefined;
  try {
    await mkdir(path.join(root, 'package'));
    await writeFile(path.join(root, 'package/package.json'), JSON.stringify({ name: '@zhivex-ai/harness', version: '1.3.0-test.1' }));
    const artifact = path.join(root, 'candidate.tgz');
    expect(spawnSync('tar', ['-czf', artifact, '-C', root, 'package']).status).toBe(0);
    child = fork(path.resolve('scripts/candidate-registry.mjs'), [artifact], { execPath: 'node', execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [message] = await once(child, 'message');
    const url = (message as { url: string }).url;
    expect(new URL(url).hostname).toBe('127.0.0.1');
    const metadata = await (await fetch(`${url}/@zhivex-ai%2fharness`)).json() as any;
    const dist = metadata.versions['1.3.0-test.1'].dist;
    const bytes = await readFile(artifact);
    expect(dist.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    expect(Buffer.from(await (await fetch(dist.tarball)).arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${url}/@zhivex-ai%2fharness`, { method: 'PUT', body: '{}' })).status).toBe(405);
    const redirect = await fetch(`${url}//attacker.invalid/path`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(new URL(redirect.headers.get('location')!).origin).toBe('https://registry.npmjs.org');
  } finally {
    if (child) { const exited = once(child, 'exit'); child.disconnect(); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
