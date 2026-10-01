import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXECUTION_FIXTURE_NAME, executionFixtureSource, liveExecutionSmokeInternals as smoke } from '../scripts/live-execution-smoke.js';

test('host-owned execution fixture produces exactly the expected provider artifact under Node', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-execution-fixture-'));
  try {
    for (const provider of ['qwen', 'meta', 'openai', 'anthropic', 'gemini', 'vertex'] as const) {
      await writeFile(path.join(workspace, EXECUTION_FIXTURE_NAME), executionFixtureSource(provider));
      const command = smoke.executionCommandInput(provider);
      expect(() => smoke.assertExecutionCommandArguments(command, provider)).not.toThrow();
      const child = Bun.spawn([command.command, ...command.args], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(await readFile(path.join(workspace, `live-execution/${provider}.txt`), 'utf8')).toBe(`${provider} enforced OCI live smoke\n`);
    }
    expect(await readFile(path.join(workspace, EXECUTION_FIXTURE_NAME), 'utf8')).toBe(executionFixtureSource('vertex'));
    const expected = smoke.executionCommandInput('qwen');
    for (const input of [
      { ...expected, args: ['-e', 'arbitrary code', 'qwen'] },
      { ...expected, args: ['--', '../other.mjs', 'qwen'] },
      { ...expected, args: ['other-fixture.mjs'] },
      { ...expected, args: [...expected.args, '--extra'] },
      { ...expected, command: 'sh' }
    ]) expect(() => smoke.assertExecutionCommandArguments(input, 'qwen')).toThrow();
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
