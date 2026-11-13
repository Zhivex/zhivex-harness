import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
test('retired browser entrypoint exits with guidance while terminal help and project commands remain', () => {
  const web = spawnSync(process.execPath, [cli, 'web'], { encoding: 'utf8' });
  expect(web.status).toBe(1);
  expect(web.stderr).toContain('Tauri');
  for (const args of [['--help'], ['project', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('zhivex-code');
  }
});
test('CLI build excludes the independent browser assets', async () => {
  expect(await readdir(new URL('../dist/', import.meta.url))).not.toContain('web-assets');
});
