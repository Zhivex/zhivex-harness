import { expect, test } from 'bun:test';
import type { McpClient, McpListedTool, ToolSet } from '@zhivex-ai/core';
import { createIsolatedMcpTools } from '../src/integrations/mcp-stdio-tools.js';
import { McpStdioClientError } from '../src/integrations/mcp-stdio-client.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const hash = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${hash}`,
  executable: '/app/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: hash,
  scope: { principal: 'p', tenant: 't', session: 's', workspace: hash }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 8192 } };
const listed = (): McpListedTool => ({ name: 'lookup', annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['allowed'] } }, required: ['choice'], additionalProperties: false } });
function execute(tools: ToolSet, value: unknown) {
  const tool = tools.mcp_docs_lookup;
  if (!tool || !('execute' in tool)) throw new Error('Missing tool');
  return tool.execute(value as never);
}
function fixture(tool = listed(), result: unknown = { content: [{ type: 'text', text: 'ok' }] }) {
  let calls = 0, closed = false;
  const client: McpClient & { close(): Promise<void> } = { async close() { closed = true; }, async listTools() { return { tools: [tool, { ...listed(), name: 'unapproved' }] }; },
    async callTool() { calls++; return result as Awaited<ReturnType<McpClient['callTool']>>; } };
  return { client, calls: () => calls, closed: () => closed };
}

test('only admitted tools are exposed and untrusted read-only hints cannot bypass interrupt approval', async () => {
  const f = fixture(); const tools = await createIsolatedMcpTools({ client: f.client, proposal });
  expect(Object.keys(tools)).toEqual(['mcp_docs_lookup']);
  expect(tools.mcp_docs_lookup).toMatchObject({ requiresApproval: true, approvalMode: 'interrupt', metadata: { untrustedContent: true } });
  expect(f.calls()).toBe(0);
});

test('full input validator checks enum and unexpected fields before dispatch', async () => {
  const f = fixture(); const tools = await createIsolatedMcpTools({ client: f.client, proposal });
  const definition = tools.mcp_docs_lookup;
  if (!definition || !('schema' in definition)) throw new Error('Missing schema');
  expect(definition.schema.safeParse({ choice: 'other' }).success).toBe(false);
  for (const input of [{}, { choice: 'other' }, { choice: 'allowed', extra: true }]) await expect(execute(tools, input)).rejects.toThrow();
  expect(f.calls()).toBe(0);
  await execute(tools, { choice: 'allowed' }); expect(f.calls()).toBe(1);
});

test('explicit secrets are scrubbed from nested content and keys before tool output', async () => {
  const f = fixture(listed(), { content: [{ type: 'text', text: 'token CANARY_VALUE' }], structuredContent: { CANARY_VALUE: ['CANARY_VALUE'] } });
  const tools = await createIsolatedMcpTools({ client: f.client, proposal, sensitiveValues: ['CANARY_VALUE'] });
  const result = await execute(tools, { choice: 'allowed' });
  expect(JSON.stringify(result)).not.toContain('CANARY_VALUE'); expect(JSON.stringify(result)).toContain('[REDACTED]');
});

test('error results cannot leak granted secrets through SDK error text', async () => {
  const f = fixture(listed(), { isError: true, content: [{ type: 'text', text: 'CANARY_VALUE failed' }] });
  const tools = await createIsolatedMcpTools({ client: f.client, proposal, sensitiveValues: ['CANARY_VALUE'] });
  try { await execute(tools, { choice: 'allowed' }); throw new Error('Expected rejection'); }
  catch (error) { expect(String(error)).not.toContain('CANARY_VALUE'); expect(String(error)).toContain('[REDACTED]'); }
});

test('sensitive discovery metadata is rejected before it becomes a tool', async () => {
  const f = fixture({ ...listed(), description: 'CANARY_VALUE' });
  await expect(createIsolatedMcpTools({ client: f.client, proposal, sensitiveValues: ['CANARY_VALUE'] })).rejects.toThrow('discovery failed');
});

for (const result of [{ content: [42] }, { content: [{ type: 'text' }] }, { content: [{ type: 'image', data: 'x' }] }, { structuredContent: [] }, {}]) {
  test('malformed result fails validation', async () => {
    const f = fixture(listed(), result); const tools = await createIsolatedMcpTools({ client: f.client, proposal });
    await expect(execute(tools, { choice: 'allowed' })).rejects.toThrow('result validation failed');
    expect(f.closed()).toBe(true);
  });
}

test('structured result must satisfy the declared output schema', async () => {
  const f = fixture({ ...listed(), outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } }, { structuredContent: { count: 'wrong' } });
  const tools = await createIsolatedMcpTools({ client: f.client, proposal });
  await expect(execute(tools, { choice: 'allowed' })).rejects.toThrow('result validation failed');
});

test('unbounded regex and references fail discovery rather than running on the host', async () => {
  for (const property of [{ type: 'string', pattern: '(a+)+$' }, { $ref: 'https://external.invalid/schema' }]) {
    const f = fixture({ ...listed(), inputSchema: { type: 'object', properties: { input: property } } });
    await expect(createIsolatedMcpTools({ client: f.client, proposal })).rejects.toThrow('discovery failed');
  }
});

test('duplicate allowed tools and repeated cursors fail bounded discovery', async () => {
  for (const response of [{ tools: [listed(), listed()] }, { tools: [], nextCursor: 'same' }]) {
    const client: McpClient & { close(): Promise<void> } = { async close() {}, async listTools() { return response; }, async callTool() { throw new Error('Unexpected'); } };
    await expect(createIsolatedMcpTools({ client, proposal })).rejects.toThrow('discovery failed');
  }
});

test('transport failure keeps unknown outcome but sanitizes diagnostics', async () => {
  const f = fixture(); f.client.callTool = async () => { throw new McpStdioClientError('cancelled', 'CANARY_VALUE', true); };
  const tools = await createIsolatedMcpTools({ client: f.client, proposal });
  try { await execute(tools, { choice: 'allowed' }); throw new Error('Expected rejection'); }
  catch (error) { expect(error).toMatchObject({ code: 'cancelled', outcomeUnknown: true }); expect(String(error)).not.toContain('CANARY_VALUE'); }
});

test('missing admitted tools fail setup and close the boundary', async () => {
  const f = fixture({ ...listed(), name: 'not-admitted' });
  await expect(createIsolatedMcpTools({ client: f.client, proposal })).rejects.toThrow('discovery failed');
  expect(f.closed()).toBe(true);
});

test('invalid result cleanup failure remains typed with uncertain effect', async () => {
  const f = fixture(listed(), {});
  f.client.close = async () => { throw new Error('cleanup-secret'); };
  const tools = await createIsolatedMcpTools({ client: f.client, proposal });
  try { await execute(tools, { choice: 'allowed' }); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'cleanup_required', outcomeUnknown: true });
    expect(String(error)).not.toContain('cleanup-secret');
  }
});
