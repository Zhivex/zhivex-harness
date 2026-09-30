import { expect, test } from 'bun:test';
import { tool } from '@zhivex-ai/core';
import { z } from 'zod';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { issueMcpHostSession, combineMcpHostSessions, resolveMcpHostSession, closeMcpHostSession } from '../src/integrations/mcp-host-session.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const digest = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${digest}`,
  executable: '/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: digest,
  scope: { principal: 'operator', tenant: 'tenant', session: 'run_one', workspace: digest }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 4096 } };

const scope = { tenantId: 'tenant', userId: 'operator' };
const store = createInMemoryAgentRunStore();
function issue(name: string, overrides: Partial<Parameters<typeof issueMcpHostSession>[0]> = {}) {
  return issueMcpHostSession({ store, runId: 'run_one', scope, proposal: { ...proposal, serverId: name },
    tools: { [name]: tool({ name, description: 'Fixture', schema: z.object({}), execute: async () => ({}) }) }, close: async () => {}, ...overrides });
}

test('combined host session preserves tool catalog and order-independent proposal identity', async () => {
  const a = issue('a'), b = issue('b');
  const first = combineMcpHostSessions([a, b]), second = combineMcpHostSessions([b, a]);
  expect(Object.keys(resolveMcpHostSession(first).tools)).toEqual(['a', 'b']);
  expect(resolveMcpHostSession(first).fingerprint).toBe(resolveMcpHostSession(second).fingerprint);
  await closeMcpHostSession(first);
  expect(() => resolveMcpHostSession(a)).toThrow('active'); expect(() => resolveMcpHostSession(b)).toThrow('active');
});

test('failed cleanup still attempts every server exactly once per combined close', async () => {
  const closed: string[] = [];
  const group = combineMcpHostSessions([issue('a', { close: async () => { closed.push('a'); throw new Error('failure'); } }),
    issue('b', { close: async () => { closed.push('b'); } })]);
  await expect(closeMcpHostSession(group)).rejects.toThrow('cleanup was not confirmed');
  await expect(closeMcpHostSession(group)).rejects.toThrow('cleanup was not confirmed');
  expect(closed.sort()).toEqual(['a', 'b']);
});

test('cross-scope and store/session mismatches cannot form a combined capability', () => {
  const a = issue('a');
  for (const overrides of [{ runId: 'other' }, { store: createInMemoryAgentRunStore() }, { scope: { ...scope, tenantId: 'other' } },
    { scope: { ...scope, namespace: 'other' } }, { proposal: { ...proposal, scope: { ...proposal.scope, workspace: `sha256:${'b'.repeat(64)}` } } }]) {
    expect(() => combineMcpHostSessions([a, issue('b', overrides)])).toThrow('scope mismatch');
  }
});

test('forged, duplicate and colliding groups are rejected', () => {
  const a = issue('a');
  expect(() => combineMcpHostSessions([{}])).toThrow('host-admitted');
  expect(() => combineMcpHostSessions([a, a])).toThrow('Invalid');
  expect(() => combineMcpHostSessions([a, issue('a')])).toThrow('collision');
  expect(() => combineMcpHostSessions([])).toThrow('Invalid');
});
