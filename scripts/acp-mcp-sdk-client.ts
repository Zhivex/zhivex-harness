/** Independent ACP v1 client process for the Docker interoperability smoke. */
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

let permissions = 0;
const notifications: unknown[] = [];
const connection = new ClientSideConnection(() => ({
  async requestPermission(params) {
    permissions++;
    assert.ok(params.options.some(option => option.optionId === 'allow_once'));
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  },
  async sessionUpdate(params) { notifications.push(params); }
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
try {
  const initialized = await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.protocolVersion, 1);
  assert.equal((initialized._meta?.zhivex as { clientMcp?: boolean })?.clientMcp, true);
  assert.equal(initialized.agentCapabilities?.loadSession, false);
  const session = await connection.newSession({ cwd: process.argv[2]!, mcpServers: ['docs', 'extra'].map(name => ({
    name, command: `/client/${name}`, args: [], env: [{ name: 'CLIENT_TOKEN', value: 'CLIENT_ENV_CANARY' }]
  })) });
  const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Use both MCP tools' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(permissions, 2);
  assert.equal(JSON.stringify(notifications).includes('CLIENT_ENV_CANARY'), false);
  assert.ok(JSON.stringify(notifications).includes('MCP completed'));
  process.stderr.write(JSON.stringify({ status: 'passed', client: '@agentclientprotocol/sdk@1.5.1', permissions }) + '\n');
  process.exit(0);
} catch {
  process.stderr.write('ACP SDK interoperability failed\n');
  process.exit(1);
}
