import { recoverMcpResources } from '../src/execution/mcp-resource-recovery.js';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRunStore } from '@zhivex-ai/core';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { reserveMcpResources, mcpResourceLabels, type McpResourcePlan } from '../src/persistence/mcp-resource-journal.js';
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


async function orphan(store: AgentRunStore, scope: ReturnType<typeof resolveHarnessConfig>['scope']) {
  const lease = await reserveMcpResources(reservation(store, scope));
  await lease.advance('provisioning');
  const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  const row = (await store.listToolCalls!('run_one', scope))[0]!;
  const plan = { ...lease.plan, ownerPid: child.pid };
  await store.saveToolCall!({ ...row, input: plan }, { expectedRevision: row.revision });
  return plan;
}
function docker(plan: McpResourcePlan) {
  const id = 'b'.repeat(64), seedId = 'c'.repeat(64);
  const containers = new Map([[id, { Id: id, Name: `/${plan.serverName}`, Image: plan.serverImageId, Config: { Labels: { ...mcpResourceLabels(plan) } } }],
    [seedId, { Id: seedId, Name: `/${plan.seederName}`, Image: plan.provisionerImageId, Config: { Labels: { ...mcpResourceLabels(plan) } } }]]);
  let volume = true, daemon = plan.daemonId;
  const mutations: string[][] = [];
  return { containers, mutations, changeDaemon() { daemon = 'foreign-daemon'; },
    async cli(args: string[]) {
      if (args[0] === 'info') return daemon;
      if (args[0] === 'ps') return [...containers.values()].filter(c => args.includes(`name=^${c.Name}$`)).map(c => c.Id).join('\n');
      if (args[0] === 'inspect') return JSON.stringify([containers.get(args[1]!)]);
      if (args[0] === 'rm') { mutations.push(args); containers.delete(args[2]!); return ''; }
      if (args[0] === 'volume' && args[1] === 'ls') return volume ? plan.volumeName : '';
      if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([{ Name: plan.volumeName, Labels: mcpResourceLabels(plan) }]);
      if (args[0] === 'volume' && args[1] === 'rm') { mutations.push(args); volume = false; return ''; }
      throw new Error('unexpected fixture operation');
    }
  };
}

test('reopened journal recovers only matching dead-owner resources and records closure', async () => fixture(async c => {
  const plan = await orphan(c.store(), c.scope), runtime = docker(plan);
  await c.reopen();
  expect(await recoverMcpResources({ store: c.store(), scope: c.scope, runId: 'run_one', hostId: 'trusted-host', cli: runtime.cli })).toEqual({ closed: 1, deferred: 0 });
  expect(runtime.mutations).toHaveLength(3);
  expect((await c.store().listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'closed' });
}));

test('live owner or another host/daemon cannot authorize recovery', async () => fixture(async c => {
  const lease = await reserveMcpResources(reservation(c.store(), c.scope)), runtime = docker(lease.plan);
  const opts = { store: c.store(), scope: c.scope, runId: 'run_one', hostId: 'trusted-host', cli: runtime.cli };
  expect(await recoverMcpResources(opts)).toEqual({ closed: 0, deferred: 1 });
  expect(await recoverMcpResources({ ...opts, hostId: 'other-host' })).toEqual({ closed: 0, deferred: 1 });
  runtime.changeDaemon();
  expect(await recoverMcpResources(opts)).toEqual({ closed: 0, deferred: 1 });
  expect(runtime.mutations).toHaveLength(0);
}));

test('foreign resource under a reserved name prevents all cleanup mutations', async () => fixture(async c => {
  const plan = await orphan(c.store(), c.scope), runtime = docker(plan);
  runtime.containers.get('c'.repeat(64))!.Config.Labels['com.zhivex.harness.mcp-owner'] = 'foreign';
  await expect(recoverMcpResources({ store: c.store(), scope: c.scope, runId: 'run_one', hostId: 'trusted-host', cli: runtime.cli })).rejects.toThrow('could not confirm cleanup');
  expect(runtime.mutations).toHaveLength(0);
  expect((await c.store().listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'cleanup_required' });
}));

test('resource absence must be confirmed after removal before closing the journal', async () => fixture(async c => {
  const plan = await orphan(c.store(), c.scope), runtime = docker(plan);
  await expect(recoverMcpResources({ store: c.store(), scope: c.scope, runId: 'run_one', hostId: 'trusted-host',
    cli: async args => args[0] === 'rm' ? '' : runtime.cli(args) })).rejects.toThrow('could not confirm cleanup');
  expect((await c.store().listToolCalls!('run_one', c.scope))[0]?.output).toEqual({ schemaVersion: 1, phase: 'cleanup_required' });
}));

test('journal write failure prevents destructive recovery commands', async () => fixture(async c => {
  const plan = await orphan(c.store(), c.scope), runtime = docker(plan);
  const store: AgentRunStore = { ...c.store(), saveToolCall() { throw new Error('write unavailable'); } };
  await expect(recoverMcpResources({ store, scope: c.scope, runId: 'run_one', hostId: 'trusted-host', cli: runtime.cli })).rejects.toThrow('write unavailable');
  expect(runtime.mutations).toHaveLength(0);
}));

test('a dead owner does not bypass host, daemon or scope binding', async () => fixture(async c => {
  const plan = await orphan(c.store(), c.scope), runtime = docker(plan);
  const options = { store: c.store(), scope: c.scope, runId: 'run_one', hostId: 'trusted-host', cli: runtime.cli };
  expect(await recoverMcpResources({ ...options, hostId: 'foreign-host' })).toEqual({ closed: 0, deferred: 1 });
  runtime.changeDaemon();
  expect(await recoverMcpResources(options)).toEqual({ closed: 0, deferred: 1 });
  const matchingRuntime = docker(plan), row = (await c.store().listToolCalls!('run_one', c.scope))[0]!;
  await c.store().saveToolCall!({ ...row, input: { ...plan, scopeHash: '0'.repeat(64) } }, { expectedRevision: row.revision });
  expect(await recoverMcpResources({ ...options, cli: matchingRuntime.cli })).toEqual({ closed: 0, deferred: 1 });
  expect(runtime.mutations).toHaveLength(0); expect(matchingRuntime.mutations).toHaveLength(0);
}));
