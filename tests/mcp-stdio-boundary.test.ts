import { expect, test } from 'bun:test';
import { normalizeHarnessMcpConfiguration } from '../src/integrations/mcp.js';

// ADR 0002 is design-only. Until admission + OCI streams ship together, parsing
// must not accept client executable instructions under any existing transport.
for (const transport of ['stdio', 'custom', 'http']) {
  test(`MCP ${transport} cannot smuggle a launch command into schema 1`, () => {
    expect(() => normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{
      name: 'client', transport, includeTools: ['lookup'], permissions: ['read'],
      command: '/usr/bin/env', args: ['node', 'server.js'], env: { NODE_OPTIONS: '--require=client.js' }
    }] })).toThrow();
  });
}
test('stdio without command remains unavailable before the isolated contract is implemented', () => {
  expect(() => normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{
    name: 'client', transport: 'stdio', includeTools: ['lookup'], permissions: ['read']
  }] })).toThrow();
});
