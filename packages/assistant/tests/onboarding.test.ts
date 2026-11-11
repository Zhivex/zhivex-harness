import { test, expect } from 'bun:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assistantDoctor } from '../src/doctor.js';

test('offline onboarding reports missing config without revealing secrets or creating state', async () => {
  const directory = await mkdtemp('/tmp/assistant-doctor-');
  try {
    const input = { directory: directory + '/runtime', ownerId: 'owner', calendar: true, telegramOwner: '123', provider: 'openai' };
    const invalid = await assistantDoctor(input, {}); expect(invalid.ok).toBe(false);
    expect(invalid.checks.filter(check => !check.ok).map(check => check.name)).toEqual(['google-client','credential-key','telegram-token']);
    const key = randomBytes(32).toString('base64'), token = '123:' + 'a'.repeat(30);
    const report = await assistantDoctor(input, { ASSISTANT_CREDENTIAL_KEY: key, ASSISTANT_GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', ASSISTANT_TELEGRAM_BOT_TOKEN: token });
    expect(report.ok).toBe(true); expect(report.mode).toBe('offline'); expect(report.unverified).toContain('OAuth consent and token validity');
    expect(JSON.stringify(report)).not.toContain(key); expect(JSON.stringify(report)).not.toContain(token);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installed CLI documents onboarding and rejects conflicting or incomplete flags before startup', () => {
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const run = (args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  expect(run(['--help']).stdout).toContain('--doctor');
  const missing = run(['--doctor', '--directory', '/private/tmp/assistant-unused', '--owner', 'owner', '--provider', 'openai', '--calendar']);
  expect(missing.status).toBe(1); expect(JSON.parse(missing.stdout).kind).toBe('assistant-doctor');
  const invalid = run(['--directory', '/private/tmp/assistant-unused', '--owner', 'owner', '--calendar-id', 'primary']);
  expect(invalid.status).toBe(1); expect(JSON.parse(invalid.stderr.split('\n').find(line => line.startsWith('{'))!).code).toBe('ASSISTANT_USAGE_INVALID');
  expect(run(['--doctor','--calendar-connect','--directory','/private/tmp/assistant-unused','--owner','owner']).status).toBe(1);
});

test('CLI config preflight selects the compatible provider without network calls or inline secrets', async () => {
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp('/tmp/assistant-cli-config-');
  try {
    const filename = directory + '/config.json';
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, provider: { kind: 'openai-compatible', baseURL: 'https://offline.example.test/v1', model: 'private-model',
      apiMode: 'chat', apiKeyEnv: 'ASSISTANT_COMPAT_TEST', capabilities: { streaming: true, tools: true } }, modules: [] }), { mode: 0o600 });
    const cli = new URL('../dist/cli.js', import.meta.url).pathname;
    const args = [cli, '--directory', directory + '/runtime', '--owner', 'owner', '--config', filename, '--doctor'];
    const result = spawnSync('node', args, { encoding: 'utf8', env: { PATH: process.env.PATH, ASSISTANT_COMPAT_TEST: 'secret-for-test' } });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).ok).toBe(true); expect(result.stdout).not.toContain('secret-for-test');
    expect(await readdir(directory)).toEqual(['config.json']);
    const conflict = spawnSync('node', [...args, '--provider', 'openai'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(conflict.status).toBe(1); expect(conflict.stderr).toContain('ASSISTANT_PROVIDER_CONFLICT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
