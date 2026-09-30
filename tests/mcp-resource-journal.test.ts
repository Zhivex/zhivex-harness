import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRunStore } from '@zhivex-ai/core';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { reserveMcpResources } from '../src/persistence/mcp-resource-journal.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const digest = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${digest}`,
  executable: '/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: digest,
  scope: { principal: 'operator', tenant: 'tenant', session: 'run_one', workspace: digest }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 4096 } };
async function fixture(run: (context: { store(): AgentRunStore; reopen(): Promise<void>; scope: ReturnType<typeof resolveHarnessConfig>['scope'] }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-journal-test-'));
  const config = resolveHarnessConfig({ workspace: root, stateDirectory: path.join(root, '.zhivex-harness'), storeBackend: 'sqlite', tenantId: 'tenant', userId: 'operator' });
  let persistence = await openHarnessPersistence(config);
  try {
    await persistence.store.save({ schemaVersion: 1, revision: 0, runId: 'run_one', scope: config.scope, provider: 'fixture', modelId: 'fixture', status: 'running',
      messages: [], steps: [], toolResults: [], outputText: '', currentStep: 0, maxSteps: 5, pendingApprovals: [], compactions: [], startedAt: Date.now(), updatedAt: Date.now() });
    await run({ store: () => persistence.store, scope: config.scope, async reopen() { persistence.close(); persistence = await openHarnessPersistence(config); } });
  } finally { persistence.close(); await rm(root, { recursive: true, force: true }); }
}
const reservation = (store: AgentRunStore, scope: ReturnType<typeof resolveHarnessConfig>['scope']) => ({
  store, scope, proposal, runId: 'run_one', hostId: 'trusted-host', daemonId: 'daemon-identity',
  serverImageId: digest, provisionerImageId: digest
});

test('resource names and ownership survive reopening SQLite without raw proposal data', async () => fixture(async c => {
  const lease = await reserveMcpResources(reservation(c.store(), c.scope));
  await lease.advance('provisioning'); await lease.advance('ready');
  await c.reopen();
  const rows = await c.store().listToolCalls!('run_one', c.scope);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.input).toEqual(lease.plan);
  expect(rows[0]?.output).toEqual({ schemaVersion: 1, phase: 'ready' });
  expect(lease.plan.serverName).toBe(`zhx-mcp-server-${lease.plan.leaseId}`);
  expect(lease.labels['com.zhivex.harness.mcp-lease']).toBe(lease.plan.leaseId);
  expect(JSON.stringify(rows)).not.toContain('trusted-host');
  expect(JSON.stringify(rows)).not.toContain('example/server');
  expect(Object.isFrozen(lease.plan)).toBe(true);
}));

test('serialized transitions persist cleanup failure and clear it only on a new cleanup attempt', async () => fixture(async c => {
  const lease = await reserveMcpResources(reservation(c.store(), c.scope));
  await Promise.all([lease.advance('provisioning'), lease.advance('ready')]);
  await lease.advance('closing'); await lease.advance('cleanup_required');
  let row = (await c.store().listToolCalls!('run_one', c.scope))[0];
  expect(row?.status).toBe('failed'); expect(row?.error?.message).toBe('MCP_RESOURCE_CLEANUP_REQUIRED');
  await lease.advance('closing');
  row = (await c.store().listToolCalls!('run_one', c.scope))[0];
  expect(row?.status).toBe('running'); expect(row?.error).toBeUndefined();
  await lease.advance('closed'); await lease.advance('closed');
  row = (await c.store().listToolCalls!('run_one', c.scope))[0];
  expect(row?.status).toBe('completed'); expect(row?.completedAt).toBeNumber();
  await expect(lease.advance('ready')).rejects.toThrow('Invalid MCP resource lifecycle transition');
}));

test('invalid transitions do not poison the queue or skip durable provisioning', async () => fixture(async c => {
  const lease = await reserveMcpResources(reservation(c.store(), c.scope));
  await expect(lease.advance('ready')).rejects.toThrow('Invalid MCP resource lifecycle transition');
  await lease.advance('provisioning');
  expect((await c.store().listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'provisioning' });
}));

test('changed resource identity cannot be advanced', async () => fixture(async c => {
  const store = c.store(), lease = await reserveMcpResources(reservation(store, c.scope));
  const row = (await store.listToolCalls!('run_one', c.scope))[0]!;
  await store.saveToolCall!({ ...row, input: { ...lease.plan, daemonId: 'other-daemon' } }, { expectedRevision: row.revision });
  await expect(lease.advance('provisioning')).rejects.toThrow('MCP resource journal identity changed');
}));

test('reservation requires matching authenticated scope before writing', async () => fixture(async c => {
  for (const change of [{ runId: 'foreign' }, { hostId: '' }, { scope: { ...c.scope, userId: 'foreign' } }, { scope: { ...c.scope, tenantId: 'foreign' } }]) {
    await expect(reserveMcpResources({ ...reservation(c.store(), c.scope), ...change })).rejects.toThrow('binding is invalid');
  }
  expect(await c.store().listToolCalls!('run_one', c.scope)).toHaveLength(0);
}));

test('failed lifecycle write leaves the previous durable phase available for retry', async () => fixture(async c => {
  const store = c.store(); let fail = true;
  const proxy: AgentRunStore = { ...store, saveToolCall(entry, options) {
    if (fail) throw new Error('fixture disk failure');
    return store.saveToolCall!(entry, options);
  } };
  const lease = await reserveMcpResources(reservation(proxy, c.scope));
  await expect(lease.advance('provisioning')).rejects.toThrow('fixture disk failure');
  expect((await store.listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'reserved' });
  fail = false; await lease.advance('provisioning');
  expect((await store.listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'provisioning' });
}));

test('a concurrent revision change prevents overwriting resource lifecycle state', async () => fixture(async c => {
  const store = c.store(); let race = true;
  const proxy: AgentRunStore = { ...store, async saveToolCall(entry, options) {
    if (race) {
      race = false;
      const current = await store.loadToolCall!(entry.runId, entry.toolCallId, entry.scope);
      await store.saveToolCall!({ ...current!, output: { schemaVersion: 1, phase: 'cleanup_required' }, status: 'failed',
        error: { message: 'MCP_RESOURCE_CLEANUP_REQUIRED' } }, { expectedRevision: current!.revision });
    }
    return store.saveToolCall!(entry, options);
  } };
  const lease = await reserveMcpResources(reservation(proxy, c.scope));
  await expect(lease.advance('provisioning')).rejects.toThrow();
  expect((await store.listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'cleanup_required' });
  await lease.advance('closing'); await lease.advance('closed');
}));
