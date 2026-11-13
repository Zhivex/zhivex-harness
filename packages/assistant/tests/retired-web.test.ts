import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
test('retired UI flags refuse before starting a host or creating state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'assistant-retired-web-'));
  try {
    for (const flag of ['--setup', '--open', '--web', '--web-port']) {
      const result = spawnSync(process.execPath, [cli, '--directory', directory, '--owner', 'test', flag], { encoding: 'utf8', timeout: 10000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Tauri');
    }
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('empty Assistant CLI invocation prints help and exits', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Tauri');
  expect(result.stdout).toContain('--directory');
});
