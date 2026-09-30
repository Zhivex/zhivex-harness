import { expect, test } from 'bun:test';
import { parseAcpMcpDescriptors, proposeAcpMcpLaunches, type AcpMcpHostRule } from '../src/client/acp-mcp-admission.js';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const digest = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${digest}`,
  executable: '/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: digest,
  scope: { principal: 'operator', tenant: 'tenant', session: 'run_one', workspace: digest }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 4096 } };

const server = { name: 'docs', command: '/opt/client/docs', args: ['--stdio'], env: [] };
const rule: AcpMcpHostRule = { clientName: 'docs', clientCommand: server.command, clientArgs: server.args,
  proposal, environmentBindings: { CLIENT_VALUE: 'ZHIVEX_MCP_VALUE' } };
const options = { rules: [rule], scope: proposal.scope, snapshotDigest: digest };

test('ACP descriptor maps exact client argv to host image, command, scope and limits without launching', async () => {
  const [mapped] = proposeAcpMcpLaunches([server], options);
  expect(mapped).toEqual(proposal); expect(mapped?.executable).not.toBe(server.command);
  let reviews = 0;
  const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'fixture', maximumLimits: proposal.limits, authorize: async () => { reviews++; return false; } });
  await expect(authority.admit(mapped!)).rejects.toThrow(); expect(reviews).toBe(1);
});

test('descriptor parsing rejects shell text, unsupported transports, control characters and authority fields', () => {
  for (const change of [{ command: 'sh -c bad' }, { command: '/bin/../sh' }, { type: 'http', url: 'https://example.test' },
    { image: 'evil' }, { permissions: ['write'] }, { args: ['bad\ncommand'] }, { env: [{ name: 'VALUE', value: 'bad\0value' }] }]) {
    expect(() => parseAcpMcpDescriptors([{ ...server, ...change }])).toThrow('Invalid ACP MCP configuration');
  }
});

test('changed arguments or unknown names cannot use an existing host mapping', () => {
  for (const change of [{ args: ['--shell'] }, { name: 'other' }, { command: '/bin/sh' }]) {
    expect(() => proposeAcpMcpLaunches([{ ...server, ...change }], options)).toThrow('no unique host mapping');
  }
  expect(() => proposeAcpMcpLaunches([server], { ...options, rules: [rule, rule] })).toThrow('no unique host mapping');
});

test('environment translation requires explicit unique bindings and cannot replace host secrets or defaults', () => {
  const input = [{ ...server, env: [{ name: 'CLIENT_VALUE', value: 'fixture-value' }] }];
  expect(proposeAcpMcpLaunches(input, options)[0]?.environment).toEqual({ ZHIVEX_MCP_VALUE: 'fixture-value' });
  for (const selected of [
    { ...rule, environmentBindings: {} }, { ...rule, environmentBindings: { CLIENT_VALUE: 'PATH' } },
    { ...rule, proposal: { ...proposal, environment: { ZHIVEX_MCP_VALUE: 'host' } } },
    { ...rule, proposal: { ...proposal, secretReferences: { ZHIVEX_MCP_VALUE: 'host-secret' } } }
  ]) expect(() => proposeAcpMcpLaunches(input, { ...options, rules: [selected] })).toThrow('not uniquely allowed');
});

test('duplicate servers, variables, target identities and excessive descriptors fail closed', () => {
  expect(() => parseAcpMcpDescriptors([server, server])).toThrow('Ambiguous');
  expect(() => parseAcpMcpDescriptors([{ ...server, env: [{ name: 'A', value: 'a' }, { name: 'A', value: 'b' }] }])).toThrow('Ambiguous');
  expect(() => parseAcpMcpDescriptors(Array.from({ length: 9 }, (_, i) => ({ ...server, name: String(i) })))).toThrow('Invalid');
  expect(() => proposeAcpMcpLaunches([server, { ...server, name: 'other' }], { ...options, rules: [rule, { ...rule, clientName: 'other' }] })).toThrow('collide');
});

test('validated descriptors and mapped proposals cannot mutate the host policy', () => {
  const parsed = parseAcpMcpDescriptors([server]);
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed[0]?.args)).toBe(true);
  const mapped = proposeAcpMcpLaunches([server], options)[0]!;
  mapped.limits.maxPids = 1; mapped.args.push('changed');
  expect(rule.proposal.limits.maxPids).toBe(16); expect(rule.proposal.args).toEqual([]);
});
