import { expect, test } from 'bun:test';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const hash = `sha256:${'a'.repeat(64)}`;
const proposal = (): McpStdioLaunchProposal => ({ schemaVersion: 1, serverId: 'docs', boundary: 'oci',
  image: `local/server@${hash}`, executable: '/usr/bin/node', args: ['/app/server.mjs'],
  protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: hash,
  scope: { principal: 'operator', tenant: 'local', session: 'session', workspace: hash },
  includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16,
    maxWorkspaceBytes: 1024 * 1024, maxFileWriteBytes: 64 * 1024, tmpfsMb: 16, maxOutputBytes: 1024 } });
const authority = (authorize: (p: Readonly<McpStdioLaunchProposal>) => Promise<boolean> = async () => true,
  extra: { now?: () => number; receiptTtlMs?: number; reviewTimeoutMs?: number } = {}) =>
  createMcpStdioAdmissionAuthority({ policyVersion: 'v1', maximumLimits: proposal().limits, authorize, ...extra });

test('host reviews frozen copy and produces opaque authority consumed exactly once', async () => {
  let reviewed: Readonly<McpStdioLaunchProposal> | undefined;
  const gate = authority(async p => { reviewed = p; return true; });
  const input = proposal(); const receipt = await gate.admit(input);
  expect(reviewed).not.toBe(input);
  expect(Object.isFrozen(reviewed?.scope)).toBe(true);
  expect(JSON.stringify(receipt)).toBe('{}');
  expect(gate.consume(receipt, input)).toEqual(input);
  expect(() => gate.consume(receipt, input)).toThrow('consumed');
});

test('forged, copied and foreign-host receipts cannot authorize a launch', async () => {
  const gate = authority(); const receipt = await gate.admit(proposal());
  for (const token of [{}, { approved: true }, JSON.parse(JSON.stringify(receipt))]) {
    expect(() => gate.consume(token, proposal())).toThrow('Unknown');
  }
  expect(() => authority().consume(receipt, proposal())).toThrow('Unknown');
  expect(gate.consume(receipt, proposal())).toEqual(proposal());
});

for (const field of ['scope', 'image', 'args', 'snapshot', 'permissions', 'secrets'] as const) {
  test(`proposal drift ${field} burns authority before launch`, async () => {
    const gate = authority(); const input = proposal(); const receipt = await gate.admit(input);
    const changed = structuredClone(input);
    if (field === 'scope') changed.scope.session = 'other';
    if (field === 'image') changed.image = `local/other@${hash}`;
    if (field === 'args') changed.args.push('--different');
    if (field === 'snapshot') changed.snapshotDigest = `sha256:${'b'.repeat(64)}`;
    if (field === 'permissions') changed.permissions.push('write');
    if (field === 'secrets') changed.secretReferences.ZHIVEX_MCP_KEY = 'newSecret';
    expect(() => gate.consume(receipt, changed)).toThrow('identity changed');
    expect(() => gate.consume(receipt, input)).toThrow('consumed');
  });
}

test('receipt expires at its deadline and stale review cannot issue authority', async () => {
  let time = 0;
  const gate = authority(async () => true, { now: () => time, receiptTtlMs: 10 });
  const receipt = await gate.admit(proposal()); time = 10;
  expect(() => gate.consume(receipt, proposal())).toThrow('expired');
  const hung = authority(async () => new Promise(() => {}), { reviewTimeoutMs: 5 });
  await expect(hung.admit(proposal())).rejects.toThrow('timed out');
});

test('denial and invalid/budget-expanding configurations produce no admission', async () => {
  await expect(authority(async () => false).admit(proposal())).rejects.toThrow('not admitted');
  let reviews = 0;
  const gate = authority(async () => { reviews++; return true; });
  for (const input of [
    { ...proposal(), approved: true }, { ...proposal(), boundary: 'host' },
    { ...proposal(), executable: 'node' }, { ...proposal(), workingDirectory: '../outside' },
    { ...proposal(), image: 'image:latest' },
    { ...proposal(), environment: { NODE_OPTIONS: '--require=secret-canary' } },
    { ...proposal(), limits: { ...proposal().limits, memoryMb: 129 } }
  ]) await expect(gate.admit(input)).rejects.toThrow();
  expect(reviews).toBe(0);
});

test('review failures do not expose host diagnostic secrets', async () => {
  const gate = authority(async () => { throw new Error('secret-canary'); });
  await expect(gate.admit(proposal())).rejects.toThrow('host admission failed');
  try { await gate.admit(proposal()); } catch (error) { expect(String(error)).not.toContain('secret-canary'); }
});

for (const key of ['maxCpus', 'maxWorkspaceBytes', 'maxFileWriteBytes', 'tmpfsMb'] as const) {
  test(`host hard maximum for ${key} cannot be raised by configuration`, async () => {
    let reviews = 0;
    const gate = authority(async () => { reviews++; return true; });
    const input = proposal(); input.limits[key] *= 2;
    await expect(gate.admit(input)).rejects.toThrow('exceeds host policy');
    expect(reviews).toBe(0);
  });
}

test('missing or inconsistent resource bounds cannot produce admission', async () => {
  const gate = authority();
  const { maxCpus: _omitted, ...incomplete } = proposal().limits;
  await expect(gate.admit({ ...proposal(), limits: incomplete })).rejects.toThrow('Invalid');
  await expect(gate.admit({ ...proposal(), limits: { ...proposal().limits, maxWorkspaceBytes: 1024 } })).rejects.toThrow('Invalid');
});
