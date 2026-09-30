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
import { launchDockerMcpTools } from '../src/execution/mcp-oci-server.js';
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

test('completed call survives reopen without raw input/output and cannot replay', async () => fixture(async c => {
  let calls = 0; const client = transport(async () => { calls++; return { content: [{ type: 'text', text: 'OUTPUT_CANARY' }] }; });
  const wrap = () => createJournaledMcpClient({ client, proposal, store: c.store(), runId: 'run_one', scope: c.scope });
  await wrap().callTool(request, callOptions);
  await c.reopen();
  const rows = await c.store().listToolCalls!('run_one', c.scope);
  expect(rows).toHaveLength(1); expect(rows[0]?.status).toBe('completed');
  expect(JSON.stringify(rows)).not.toContain('ARGUMENT_CANARY'); expect(JSON.stringify(rows)).not.toContain('OUTPUT_CANARY');
  await expect(wrap().callTool(request, callOptions)).rejects.toMatchObject({ code: 'replay_denied', outcomeUnknown: false });
  expect(calls).toBe(1);
}));

test('interrupted effect remains unknown after reopen without retry', async () => fixture(async c => {
  let calls = 0; const client = transport(async () => { calls++; throw new McpStdioClientError('cancelled', 'PRIVATE_DIAGNOSTIC', true); });
  const wrap = () => createJournaledMcpClient({ client, proposal, store: c.store(), runId: 'run_one', scope: c.scope });
  await expect(wrap().callTool(request, callOptions)).rejects.toMatchObject({ code: 'outcome_unknown', outcomeUnknown: true });
  await c.reopen();
  const rows = await c.store().listToolCalls!('run_one', c.scope);
  expect(rows[0]?.error?.message).toBe('MCP_OUTCOME_UNKNOWN'); expect(JSON.stringify(rows)).not.toContain('PRIVATE_DIAGNOSTIC');
  await expect(wrap().callTool(request, callOptions)).rejects.toMatchObject({ code: 'outcome_unknown' }); expect(calls).toBe(1);
  await expect(wrap().callTool(request, { idempotencyKey: 'new-key-cannot-bypass-reconciliation' })).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(calls).toBe(1);
}));

test('lost completion write leaves an unreplayable durable claim', async () => fixture(async c => {
  let calls = 0; const client = transport(async () => { calls++; return { content: [] }; });
  const broken: AgentRunStore = { ...c.store(), completeToolExecution() { throw new Error('disk failure'); } };
  const first = createJournaledMcpClient({ client, proposal, store: broken, runId: 'run_one', scope: c.scope });
  await expect(first.callTool(request, callOptions)).rejects.toMatchObject({ code: 'persistence_failed', outcomeUnknown: true });
  await c.reopen();
  const next = createJournaledMcpClient({ client, proposal, store: c.store(), runId: 'run_one', scope: c.scope });
  await expect(next.callTool(request, callOptions)).rejects.toMatchObject({ code: 'outcome_unknown' }); expect(calls).toBe(1);
}));

test('claim failure and missing execution key cause zero dispatches', async () => fixture(async c => {
  let calls = 0; const client = transport(async () => { calls++; return { content: [] }; });
  const broken: AgentRunStore = { ...c.store(), claimToolExecution() { throw new Error('PRIVATE'); } };
  const wrapped = createJournaledMcpClient({ client, proposal, store: broken, runId: 'run_one', scope: c.scope });
  await expect(wrapped.callTool(request)).rejects.toMatchObject({ code: 'identity_changed' });
  await expect(wrapped.callTool(request, callOptions)).rejects.toMatchObject({ code: 'persistence_failed', outcomeUnknown: false });
  expect(calls).toBe(0);
}));

test('concurrent callers cannot both dispatch the same admitted operation', async () => fixture(async c => {
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const client = transport(async () => { calls++; started(); await done; return { content: [] }; });
  const wrap = () => createJournaledMcpClient({ client, proposal, store: c.store(), runId: 'run_one', scope: c.scope });
  const first = wrap().callTool(request, callOptions); await ready;
  await expect(wrap().callTool(request, callOptions)).rejects.toMatchObject({ code: 'outcome_unknown' });
  finish(); await first; expect(calls).toBe(1);
}));

test('argument or proposal drift with the same key cannot authorize another effect', async () => fixture(async c => {
  let calls = 0; const client = transport(async () => { calls++; return { content: [] }; });
  const wrap = (selected = proposal) => createJournaledMcpClient({ client, proposal: selected, store: c.store(), runId: 'run_one', scope: c.scope });
  await wrap().callTool(request, callOptions); await c.reopen();
  await expect(wrap().callTool({ ...request, arguments: { query: 'different' } }, callOptions)).rejects.toMatchObject({ code: 'identity_changed' });
  await expect(wrap({ ...proposal, args: ['--changed'] }).callTool(request, callOptions)).rejects.toMatchObject({ code: 'identity_changed' });
  expect(calls).toBe(1);
}));

test('journal host identity must agree with admitted principal, tenant and run', async () => fixture(async c => {
  const client = transport(async () => ({ content: [] }));
  for (const change of [{ runId: 'another' }, { scope: { ...c.scope, tenantId: 'other' } }, { scope: { ...c.scope, userId: 'other' } }]) {
    expect(() => createJournaledMcpClient({ client, proposal, store: c.store(), runId: 'run_one', scope: c.scope, ...change })).toThrow('identity_changed');
  }
}));

test('runtime callers cannot omit the journal even when bypassing TypeScript', async () => {
  await expect(launchDockerMcpTools({ snapshot: {}, scope: proposal.scope } as never)).rejects.toThrow('requires a matching durable journal');
});
