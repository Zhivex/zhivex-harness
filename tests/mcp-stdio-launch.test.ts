import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { prepareMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot } from '../src/execution/mcp-workspace-snapshot.js';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
import { withAdmittedMcpLaunch } from '../src/integrations/mcp-stdio-launch.js';

async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-launch-test-'));
  const context = await setup(root);
  try { await run(context); }
  finally { await discardMcpWorkspaceSnapshot(context.snapshot); await rm(root, { recursive: true, force: true }); }
}
async function setup(root: string) {
  await writeFile(path.join(root, 'approved.txt'), 'approved bytes');
  const snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 4096);
  const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'local', boundary: 'oci',
    image: `example/server@sha256:${'a'.repeat(64)}`, executable: '/usr/bin/server', args: [],
    protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: snapshot.digest,
    scope: { principal: 'operator', tenant: 'tenant', session: 'session', workspace: snapshot.workspace },
    includeTools: ['lookup'], permissions: ['read'], environment: { ZHIVEX_MCP_FORMAT: 'text' },
    secretReferences: { ZHIVEX_MCP_KEY: 'hostCredential' },
    limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16,
      maxWorkspaceBytes: 4096, maxFileWriteBytes: 1024, tmpfsMb: 16, maxOutputBytes: 1024 } };
  const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'v1', maximumLimits: proposal.limits, authorize: async () => true });
  const receipt = await authority.admit(proposal);
  return { root, snapshot, proposal, authority, receipt, scope: { ...proposal.scope } };
}

test('single admitted handoff binds reviewed snapshot, host scope and explicit secrets', async () => fixture(async c => {
  await writeFile(path.join(c.root, 'approved.txt'), 'changed after admission');
  let lookups = 0;
  const result = await withAdmittedMcpLaunch({ ...c,
    resolveSecret: async (reference, signal) => { expect(reference).toBe('hostCredential'); expect(signal.aborted).toBe(false); lookups++; return 'secret-canary'; },
    seed: async ({ proposal, environment, files }) => {
      expect(Object.isFrozen(proposal)).toBe(true); expect(Object.isFrozen(environment)).toBe(true);
      expect(environment).toEqual({ HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', HOSTNAME: 'mcp', ZHIVEX_MCP_FORMAT: 'text', ZHIVEX_MCP_KEY: 'secret-canary' });
      expect(JSON.stringify(proposal)).not.toContain('secret-canary');
      const values = []; for await (const file of files) values.push(new TextDecoder().decode(file.contents));
      expect(values).toEqual(['approved bytes']); return 'seeded';
    } });
  expect(result).toBe('seeded'); expect(lookups).toBe(1);
  await expect(withAdmittedMcpLaunch({ ...c, resolveSecret: async () => { throw new Error('must not run'); }, seed: async () => {} }))
    .rejects.toThrow('handoff failed');
}));

for (const field of ['principal', 'tenant', 'session', 'workspace'] as const) {
  test(`authenticated ${field} mismatch produces no lookup or boundary creation`, async () => fixture(async c => {
    let effects = 0;
    c.scope[field] = 'different';
    await expect(withAdmittedMcpLaunch({ ...c, resolveSecret: async () => { effects++; return 'value'; }, seed: async () => { effects++; } }))
      .rejects.toThrow('handoff failed');
    expect(effects).toBe(0);
    expect(() => c.authority.consume(c.receipt, c.proposal)).toThrow('consumed');
  }));
}

for (const defect of ['forged-receipt', 'proposal-drift', 'forged-snapshot'] as const) {
  test(`${defect} cannot reach secrets or creation`, async () => fixture(async c => {
    let effects = 0;
    if (defect === 'proposal-drift') c.proposal.args.push('--changed');
    await expect(withAdmittedMcpLaunch({ ...c,
      receipt: defect === 'forged-receipt' ? {} : c.receipt,
      snapshot: defect === 'forged-snapshot' ? JSON.parse(JSON.stringify(c.snapshot)) : c.snapshot,
      resolveSecret: async () => { effects++; return 'value'; }, seed: async () => { effects++; } }))
      .rejects.toThrow('handoff failed');
    expect(effects).toBe(0);
  }));
}

for (const secret of [undefined, '', 'invalid\nline', 'x'.repeat(32 * 1024 + 1)]) {
  test('missing, invalid or oversized secret rejects before seeding', async () => fixture(async c => {
    let seeds = 0;
    await expect(withAdmittedMcpLaunch({ ...c, resolveSecret: async () => secret, seed: async () => { seeds++; } }))
      .rejects.toThrow('MCP admitted launch handoff failed.');
    expect(seeds).toBe(0);
  }));
}

test('secret resolver and seed failures are sanitized', async () => fixture(async c => {
  await expect(withAdmittedMcpLaunch({ ...c, resolveSecret: async () => { throw new Error('credential-canary'); }, seed: async () => {} }))
    .rejects.toThrow('MCP admitted launch handoff failed.');
}));

test('hung credential resolution aborts and never creates a boundary', async () => fixture(async c => {
  let signal: AbortSignal | undefined; let seeds = 0;
  const result = withAdmittedMcpLaunch({ ...c,
    resolveSecret: async (_reference, active) => { signal = active; return new Promise(() => {}); },
    seed: async () => { seeds++; } });
  await expect(result).rejects.toThrow('MCP admitted launch handoff failed.');
  expect(signal?.aborted).toBe(true); expect(seeds).toBe(0);
}), 7000);

test('seed errors cannot expose server diagnostics', async () => fixture(async c => {
  await expect(withAdmittedMcpLaunch({ ...c, resolveSecret: async () => 'secret', seed: async () => { throw new Error('server-canary'); } }))
    .rejects.toThrow('MCP admitted launch handoff failed.');
}));
