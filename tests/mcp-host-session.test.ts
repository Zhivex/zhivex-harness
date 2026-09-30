import { expect, test } from 'bun:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@zhivex-ai/core';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { issueMcpHostSession } from '../src/integrations/mcp-host-session.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const digest = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${digest}`,
  executable: '/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: digest,
  scope: { principal: 'operator', tenant: 'tenant', session: 'run_one', workspace: digest }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 4096 } };
async function fixture(run: (c: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const c = await setup();
  try { await run(c); } finally { await rm(c.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcp-host-session-')));
  const config = resolveHarnessConfig({ workspace: root, tenantId: 'tenant', userId: 'operator' });
  const store = createInMemoryAgentRunStore();
  let calls = 0, closes = 0;
  const issue = (args: string[] = []) => issueMcpHostSession({ store, runId: 'run_one', scope: config.scope,
    proposal: { ...proposal, args, scope: { ...proposal.scope, workspace: `sha256:${createHash('sha256').update(root).digest('hex')}` } },
    tools: { mcp_docs_lookup: tool({ name: 'mcp_docs_lookup', description: 'Lookup', schema: z.object({}), requiresApproval: true, approvalMode: 'interrupt',
      execute: async () => { calls++; return { ok: true }; } }) }, close: async () => { closes++; } });
  const create = (token = issue(), resuming = false) => createHarness({ workspace: root, tenantId: 'tenant', userId: 'operator', store,
    isolatedMcpSession: token, subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: resuming ? [[
      { type: 'text-delta', textDelta: 'Done' }, { type: 'finish', finishReason: 'stop' }
    ]] : [[{ type: 'tool-call', toolCall: { id: 'lookup', name: 'mcp_docs_lookup', input: {} } }, { type: 'finish', finishReason: 'tool-calls' }],
      [{ type: 'text-delta', textDelta: 'Done' }, { type: 'finish', finishReason: 'stop' }]] }) });
  return { root, config, store, issue, create, calls: () => calls, closes: () => closes };
}

test('serialized or forged host capabilities cannot expose MCP tools', async () => fixture(async c => {
  await expect(c.create({})).rejects.toThrow('host-admitted MCP session');
  expect(c.calls()).toBe(0);
}));

test('denied agent approval never dispatches an admitted MCP tool', async () => fixture(async c => {
  const harness = await c.create();
  try {
    const waiting = await runHarness(harness, { runId: 'run_one', prompt: 'lookup' });
    expect(waiting.status).toBe('waiting_approval'); expect(c.calls()).toBe(0);
    await runHarness(harness, { state: waiting.state, approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: false })) });
    expect(c.calls()).toBe(0);
  } finally { await harness.close(); }
}));

test('changed admitted proposal invalidates a persisted tool approval before execution', async () => fixture(async c => {
  const first = await c.create();
  const waiting = await runHarness(first, { runId: 'run_one', prompt: 'lookup' });
  await first.close();
  const second = await c.create(c.issue(['--changed']), true);
  try {
    await expect(runHarness(second, { state: waiting.state, approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) })).rejects.toThrow();
    expect(c.calls()).toBe(0);
  } finally { await second.close(); }
}));

test('different run and closed session fail before any MCP execution', async () => fixture(async c => {
  const token = c.issue(), harness = await c.create(token);
  await expect(runHarness(harness, { runId: 'other', prompt: 'lookup' })).rejects.toThrow('does not match');
  await harness.close();
  await expect(c.create(token)).rejects.toThrow('active host-admitted');
  expect(c.calls()).toBe(0);
}));

test('host capability cannot be rebound to another store or workspace', async () => fixture(async c => {
  const token = c.issue();
  await expect(createHarness({ workspace: c.root, tenantId: 'tenant', userId: 'operator', store: createInMemoryAgentRunStore(),
    isolatedMcpSession: token, modelInstance: createMockLanguageModel({}) })).rejects.toThrow('store, workspace and scope');
  expect(c.closes()).toBe(1); expect(c.calls()).toBe(0);
}));
