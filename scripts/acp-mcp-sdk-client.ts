/** Independent ACP v1 client process for the Docker interoperability smoke. */
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, type NewSessionRequest, type PromptRequest } from '@agentclientprotocol/sdk';

let permissions = 0;
const notifications: unknown[] = [];
// SDK 2.1 removed the ClientSideConnection class. ClientApp.connect returns a
// ClientConnection whose agent context sends the same v1 requests.
const connection = client()
  .onRequest('session/request_permission', async ({ params }) => {
    permissions++;
    assert.ok(params.options.some(option => option.optionId === 'allow_once'));
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  })
  .onNotification('session/update', async ({ params }) => { notifications.push(params); })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
try {
  const initialized = await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.protocolVersion, 1);
  assert.equal((initialized._meta?.zhivex as { clientMcp?: boolean })?.clientMcp, true);
  assert.equal(initialized.agentCapabilities?.loadSession, false);
  const sessionRequest: NewSessionRequest = { cwd: process.argv[2]!, mcpServers: ['docs', 'extra'].map(name => ({
    name, command: `/client/${name}`, args: [], env: [{ name: 'CLIENT_TOKEN', value: 'CLIENT_ENV_CANARY' }]
  })) };
  const session = await connection.agent.request('session/new', sessionRequest);
  const promptRequest: PromptRequest = { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Use both MCP tools' }] };
  const result = await connection.agent.request('session/prompt', promptRequest);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(permissions, 2);
  assert.equal(JSON.stringify(notifications).includes('CLIENT_ENV_CANARY'), false);
  assert.ok(JSON.stringify(notifications).includes('MCP completed'));
  process.stderr.write(JSON.stringify({ status: 'passed', client: '@agentclientprotocol/sdk@2.1.0', permissions }) + '\n');
  process.exit(0);
} catch {
  process.stderr.write('ACP SDK interoperability failed\n');
  process.exit(1);
}
