import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
import { createAcpMcpHost } from '../src/client/acp-mcp-host.js';
import { createAcpConnection } from '../src/client/acp.js';
const digest = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${digest}`,
  executable: '/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: digest,
  scope: { principal: 'operator', tenant: 'tenant', session: 'run_one', workspace: digest }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 4096 } };


const descriptor = { name: 'docs', command: '/client/docs', args: [], env: [] };
async function fixture(authorize: (proposal: Readonly<McpStdioLaunchProposal>) => Promise<boolean>, run: (c: any) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'acp-mcp-host-'));
  const host = await createAcpMcpHost({ harness: { workspace: root, tenantId: 'tenant', userId: 'operator', subagentProfiles: [],
    modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] }) },
    rules: [{ clientName: 'docs', clientCommand: descriptor.command, clientArgs: [], proposal, environmentBindings: {} }],
    authority: createMcpStdioAdmissionAuthority({ policyVersion: 'fixture', maximumLimits: proposal.limits, authorize }),
    provisionerImageId: digest, hostId: 'fixture-host', resolveSecret: async () => undefined });
  const connection = createAcpConnection(host.adapter, { workspace: host.workspace, mcpSessionProvider: host.mcpSessionProvider,
    notify: () => {}, requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }) });
  let id = 0;
  const call = (method: string, params: unknown) => connection.handle({ jsonrpc: '2.0', id: ++id, method, params });
  try { await run({ host, connection, call }); } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}

test('only wired host capability advertises client MCP and unknown mapping is rejected before session allocation', async () => fixture(async () => false, async ({ host, call }) => {
  const initialized = await call('initialize', { protocolVersion: 1 });
  expect(initialized.result._meta.zhivex.clientMcp).toBe(true);
  expect(initialized.result.agentCapabilities.mcpCapabilities).toEqual({ http: false, sse: false });
  expect((await call('session/new', { cwd: host.workspace, mcpServers: [{ ...descriptor, command: '/bin/sh' }] })).error.code).toBe(-32602);
  const session = await call('session/new', { cwd: host.workspace, mcpServers: [] });
  expect((await call('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'hello' }] })).result.stopReason).toBe('end_turn');
}));

test('client descriptor reaches real admission with host-owned image, run and command', async () => {
  let reviews = 0;
  await fixture(async reviewed => { reviews++; expect(reviewed.executable).toBe('/server'); expect(reviewed.image).toBe(proposal.image);
    expect(reviewed.scope.session).toMatch(/^run_/); return false; }, async ({ host, call }) => {
    await call('initialize', { protocolVersion: 1 });
    const session = await call('session/new', { cwd: host.workspace, mcpServers: [descriptor] });
    const result = await call('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'lookup' }] });
    expect(result.error.message).toBe('EXECUTION_FAILED'); expect(reviews).toBe(1);
  });
});

test('cancelling pending host admission finishes without waiting for a late decision', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let decide!: (allowed: boolean) => void;
  await fixture(async () => { entered(); return new Promise<boolean>(resolve => { decide = resolve; }); }, async ({ host, call }) => {
    await call('initialize', { protocolVersion: 1 });
    const session = await call('session/new', { cwd: host.workspace, mcpServers: [descriptor] });
    const pending = call('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'lookup' }] });
    await ready; await call('session/cancel', { sessionId: session.result.sessionId });
    expect((await pending).result.stopReason).toBe('cancelled'); decide(true);
  });
});

test('serialized capability cannot enable MCP on a connection', async () => fixture(async () => false, async ({ host }) => {
  expect(() => createAcpConnection(host.adapter, { workspace: host.workspace, mcpSessionProvider: {}, notify: () => {}, requestPermission: async () => ({}) })).toThrow('host-owned adapter capability');
}));
