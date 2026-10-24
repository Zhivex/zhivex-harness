import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTINUITY_PROVIDER_ATTEMPTS, continuityGateOutcome, continuityRetrySummaryLines, createContinuityEvidence,
  runContinuityProviderWithRetry } from '../scripts/live-continuity-contract.js';

const secret = 'PRIVATE_MODEL_TEXT_DO_NOT_LOG';
const root = path.resolve(import.meta.dir, '..');
const passed = (provider: string) => ({ provider, model: 'm', status: 'passed', processStarts: 6, phases: [{ phase: 0, status: 'passed' }] });
const toolCallFailure = (provider: string) => ({ provider, model: 'm', status: 'failed', processStarts: 2, phases: [
  { phase: 0, status: 'passed' },
  { phase: 1, status: 'failed', message: secret, checks: { completed: false, objective: false, noTools: false, codename: true },
    evidence: createContinuityEvidence().snapshot({ outputText: secret, finishReason: 'tool-calls', usage: { inputTokens: 6215, outputTokens: 3930 } }) }
] });
const scripted = (...rows: Record<string, unknown>[]) => {
  const calls: number[] = [];
  return { calls, run: async (attempt: number) => { calls.push(attempt); return rows[attempt - 1]!; } };
};
const runGate = async (gate: string, providers: unknown[]) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-continuity-retry-'));
  try {
    const out = path.join(dir, `${gate}.json`);
    const envelope = { ok: providers.every(outcome => (outcome as { ok: boolean }).ok), providers };
    const child = Bun.spawn([process.execPath, 'run', 'scripts/run-release-gate.ts', '--gate', gate, '--out', out, '--', process.execPath, '-e',
      `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))}); process.exitCode=${envelope.ok ? 0 : 1};`], { cwd: root, env: { ...process.env,
      RELEASE_TAG: 'v1.6.2', SOURCE_COMMIT: 'a'.repeat(40), ARTIFACT_SHA512: `sha512-${Buffer.alloc(64).toString('base64')}`,
      WORKFLOW_RUN_URL: 'https://github.com/Zhivex/zhivex-harness/actions/runs/1', WORKFLOW_RUN_ATTEMPT: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const code = await child.exited;
    return { code, diagnostic: JSON.parse(await readFile(out, 'utf8')) };
  } finally { await rm(dir, { recursive: true, force: true }); }
};

test('a provider that passes first try runs once and records no retry', async () => {
  const attempts = scripted(passed('qwen'));
  const row = await runContinuityProviderWithRetry('qwen', attempts.run);
  expect(attempts.calls).toEqual([1]);
  expect(row).toMatchObject({ provider: 'qwen', status: 'passed', attempts: 1 });
  expect(row.retry).toBeUndefined();
  expect(continuityRetrySummaryLines([row])).toEqual([]);
  expect(continuityGateOutcome(row)).toEqual({ provider: 'qwen', ok: true });
});

test('a failed provider gets one fresh retry and the first cause is recorded without provider text', async () => {
  const attempts = scripted(toolCallFailure('meta'), passed('meta'));
  const row = await runContinuityProviderWithRetry('meta', attempts.run);
  expect(attempts.calls).toEqual([1, 2]);
  expect(CONTINUITY_PROVIDER_ATTEMPTS).toBe(2);
  expect(row).toMatchObject({ provider: 'meta', status: 'passed', attempts: 2, processStarts: 6 });
  const first = (row.retry as { firstAttempt: Record<string, unknown>; outcome: string });
  expect(first.outcome).toBe('passed');
  expect(first.firstAttempt).toMatchObject({ status: 'failed', code: 'EXECUTION_FAILED', retryable: false, phase: 1,
    failedChecks: ['completed', 'objective', 'noTools'], finishReason: 'tool-calls' });
  expect(first.firstAttempt.fingerprint).toEqual(continuityGateOutcome(toolCallFailure('meta')).error!.fingerprint);
  expect(first.firstAttempt.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  const [line] = continuityRetrySummaryLines([row]);
  expect(line).toContain('Continuity retry: meta first attempt failed (EXECUTION_FAILED, phase 1, failed checks [completed, objective, noTools], finishReason tool-calls, fingerprint sha256:');
  expect(line).toEndWith('retry passed.');
  expect(JSON.stringify(row.retry) + line).not.toContain(secret);
  const gate = await runGate('continuity', [continuityGateOutcome(row), continuityGateOutcome(passed('qwen'))]);
  expect(gate.code).toBe(0);
  expect(gate.diagnostic).toMatchObject({ status: 'passed', outcomes: [{ provider: 'meta', status: 'passed' }, { provider: 'qwen', status: 'passed' }] });
});

test('a provider that fails its retry fails the gate and never gets a third attempt', async () => {
  const attempts = scripted(toolCallFailure('openai'), toolCallFailure('openai'), passed('openai'));
  const row = await runContinuityProviderWithRetry('openai', attempts.run);
  expect(attempts.calls).toEqual([1, 2]);
  expect(row).toMatchObject({ provider: 'openai', status: 'failed', attempts: 2, retry: { outcome: 'failed' } });
  expect(continuityRetrySummaryLines([row])[0]).toEndWith('retry failed.');
  const outcome = continuityGateOutcome(row);
  expect(outcome.ok).toBe(false);
  const gate = await runGate('continuity', [continuityGateOutcome(passed('meta')), outcome]);
  expect(gate.code).toBe(1);
  expect(gate.diagnostic.status).toBe('failed');
  expect(gate.diagnostic.outcomes[1]).toMatchObject({ provider: 'openai', status: 'failed', error: { code: 'EXECUTION_FAILED' } });
});

test('missing credentials are not retried and stay a failure', async () => {
  const attempts = scripted({ provider: 'vertex', model: 'm', status: 'missing_credentials' }, passed('vertex'));
  const row = await runContinuityProviderWithRetry('vertex', attempts.run);
  expect(attempts.calls).toEqual([1]);
  expect(row).toMatchObject({ status: 'missing_credentials', attempts: 1 });
  expect(continuityGateOutcome(row).ok).toBe(false);
});

test('other gates are unaffected: only the continuity script retries providers, and both workflows run it', async () => {
  const scripts = await readdir(path.join(root, 'scripts'));
  const users: string[] = [];
  for (const name of scripts.filter(file => file.endsWith('.ts'))) {
    if ((await readFile(path.join(root, 'scripts', name), 'utf8')).includes('runContinuityProviderWithRetry')) users.push(name);
  }
  expect(users.sort()).toEqual(['live-continuity-contract.ts', 'live-continuity-smoke.ts']);
  for (const workflow of ['live-certification.yml', 'release.yml']) {
    const source = await readFile(path.join(root, '.github', 'workflows', workflow), 'utf8');
    expect(source).toContain('--gate continuity\n          --out release-artifacts/live-diagnostics/continuity.json\n          -- bun run scripts/live-continuity-smoke.ts');
  }
  // A failed provider in any other gate still fails on its single run.
  const gate = await runGate('base', [{ provider: 'meta', ok: true }, continuityGateOutcome(toolCallFailure('qwen'))]);
  expect(gate.code).toBe(1);
  expect(gate.diagnostic).toMatchObject({ gate: 'base', status: 'failed' });
});
