import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRunStore, McpClient } from '@zhivex-ai/core';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { createJournaledMcpClient } from '../src/persistence/mcp-execution-journal.js';
import { McpStdioClientError } from '../src/integrations/mcp-stdio-client.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
import { createMcpReconciliationAuthority } from '../src/persistence/mcp-reconciliation.js';
import { reserveMcpResources } from '../src/persistence/mcp-resource-journal.js';
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
function transport(invoke: McpClient['callTool']) { return { listTools: async () => ({ tools: [] }), callTool: invoke, close: async () => {} }; }
const request = { name: 'lookup', arguments: { query: 'ARGUMENT_CANARY' } };
const callOptions = { idempotencyKey: 'approved-call-one' };


async function unresolved(c: Parameters<Parameters<typeof fixture>[0]>[0], close = true) {
  const lease = await reserveMcpResources({ store: c.store(), runId: 'run_one', scope: c.scope, hostId: 'trusted-host', daemonId: 'fixture-daemon',
    proposal, serverImageId: digest, provisionerImageId: digest });
  await lease.advance('provisioning');
  const client = createJournaledMcpClient({ client: transport(async () => { throw new McpStdioClientError('cancelled', 'private', true); }),
    proposal, store: c.store(), runId: 'run_one', scope: c.scope });
  await expect(client.callTool(request, callOptions)).rejects.toMatchObject({ code: 'outcome_unknown' });
  if (close) { await lease.advance('closing'); await lease.advance('closed'); }
  const row = (await c.store().listToolCalls!('run_one', c.scope)).find(entry => entry.toolName === 'isolated_mcp_call')!;
  return { toolCallId: row.toolCallId, expectedRevision: row.revision, outcome: 'no_effect_confirmed' as const, evidenceDigest: digest };
}

test('authorized resolution persists after reopen, never replays original key, and permits a new approved key', async () => fixture(async c => {
  const decision = await unresolved(c);
  let reviewed = false;
  await createMcpReconciliationAuthority({ store: c.store(), runId: 'run_one', scope: c.scope, hostId: 'trusted-host', authorize: async review => {
    reviewed = true; expect(Object.isFrozen(review)).toBe(true); expect(review.argumentsHash).toMatch(/^[a-f0-9]{64}$/); return true;
  } }).reconcile(decision);
  await c.reopen();
  const row = await c.store().loadToolCall!('run_one', decision.toolCallId, c.scope);
  expect(row?.status).toBe('failed'); expect(row?.error?.message).toBe('MCP_OUTCOME_RECONCILED');
  expect(row?.output).toMatchObject({ outcome: 'no_effect_confirmed', previousError: 'MCP_OUTCOME_UNKNOWN', actor: 'operator' });
  expect(JSON.stringify(row)).not.toContain('ARGUMENT_CANARY'); expect(reviewed).toBe(true);
  let calls = 0;
  const client = createJournaledMcpClient({ client: transport(async () => { calls++; return { content: [] }; }), proposal, store: c.store(), runId: 'run_one', scope: c.scope });
  await expect(client.callTool(request, callOptions)).rejects.toMatchObject({ code: 'replay_denied' });
  expect(calls).toBe(0);
  await client.callTool(request, { idempotencyKey: 'separately-approved-new-call' }); expect(calls).toBe(1);
}));

test('denied reconciliation leaves outcome unknown and new keys blocked', async () => fixture(async c => {
  const decision = await unresolved(c);
  await expect(createMcpReconciliationAuthority({ store: c.store(), runId: 'run_one', scope: c.scope, hostId: 'trusted-host', authorize: async () => false }).reconcile(decision)).rejects.toThrow('not authorized');
  expect((await c.store().loadToolCall!('run_one', decision.toolCallId, c.scope))?.error?.message).toBe('MCP_OUTCOME_UNKNOWN');
}));

test('cleanup must be confirmed before the operator is asked to resolve', async () => fixture(async c => {
  const decision = await unresolved(c, false); let reviews = 0;
  await expect(createMcpReconciliationAuthority({ store: c.store(), runId: 'run_one', scope: c.scope, hostId: 'trusted-host', authorize: async () => { reviews++; return true; } }).reconcile(decision)).rejects.toThrow('confirmed resource cleanup');
  expect(reviews).toBe(0);
}));

test('cross-host and cross-scope decisions cannot resolve an unknown effect', async () => fixture(async c => {
  const decision = await unresolved(c); let reviews = 0;
  const base = { store: c.store(), runId: 'run_one', scope: c.scope, hostId: 'trusted-host', authorize: async () => { reviews++; return true; } };
  await expect(createMcpReconciliationAuthority({ ...base, hostId: 'foreign' }).reconcile(decision)).rejects.toThrow();
  await expect(createMcpReconciliationAuthority({ ...base, scope: { ...c.scope, userId: 'foreign' } }).reconcile(decision)).rejects.toThrow();
  expect(reviews).toBe(0);
}));

test('a concurrent resolution makes the reviewed revision stale', async () => fixture(async c => {
  const decision = await unresolved(c);
  const base = { store: c.store(), runId: 'run_one', scope: c.scope, hostId: 'trusted-host' };
  const second = createMcpReconciliationAuthority({ ...base, authorize: async () => true });
  const first = createMcpReconciliationAuthority({ ...base, authorize: async () => { await second.reconcile({ ...decision, outcome: 'effect_confirmed' }); return true; } });
  await expect(first.reconcile(decision)).rejects.toThrow('stale');
  expect((await c.store().loadToolCall!('run_one', decision.toolCallId, c.scope))?.output).toMatchObject({ outcome: 'effect_confirmed' });
}));

test('lost reconciliation write preserves the unknown outcome', async () => fixture(async c => {
  const decision = await unresolved(c);
  const store: AgentRunStore = { ...c.store(), saveToolCall() { throw new Error('disk failure'); } };
  await expect(createMcpReconciliationAuthority({ store, runId: 'run_one', scope: c.scope, hostId: 'trusted-host', authorize: async () => true }).reconcile(decision)).rejects.toThrow('disk failure');
  await c.reopen();
  expect((await c.store().loadToolCall!('run_one', decision.toolCallId, c.scope))?.error?.message).toBe('MCP_OUTCOME_UNKNOWN');
}));
