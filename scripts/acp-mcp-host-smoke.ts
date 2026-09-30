import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveAcpStdio } from '../src/client/acp-stdio.js';
import { createAcpMcpHost } from '../src/client/acp-mcp-host.js';
import { createAcpConnection } from '../src/client/acp.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
import { runPortableProcess } from '../src/execution/process-runtime.js';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
  .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
async function docker(args: string[]) {
  const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 30_000, maxOutputCharacters: 64 * 1024 });
  assert.equal(result.exitCode, 0, 'MCP tools smoke Docker operation failed');
  assert.equal(result.timedOut, false); return result.stdout.trim();
}
const image = JSON.parse(await docker(['image', 'inspect', process.env.HARNESS_MCP_SMOKE_IMAGE ?? 'node:22-alpine']))[0];
const owned = async () => ({ containers: await docker(['ps', '--all', '--quiet', '--filter', `label=com.zhivex.harness.owner-pid=${process.pid}`, '--filter', 'label=com.zhivex.harness.mcp=v1']),
  volumes: await docker(['volume', 'ls', '--quiet', '--filter', `label=com.zhivex.harness.owner-pid=${process.pid}`, '--filter', 'label=com.zhivex.harness.mcp=v1']) });
const baseline = await owned();
const root = await mkdtemp(path.join(tmpdir(), 'zhx-mcp-tools-smoke-'));
const config = resolveHarnessConfig({ workspace: root, stateDirectory: path.join(root, '.zhivex-harness'), storeBackend: 'sqlite', tenantId: 'local', userId: 'smoke' });
const persistence = await openHarnessPersistence(config);
let host: Awaited<ReturnType<typeof createAcpMcpHost>> | undefined;
try {
  await writeFile(path.join(root, 'data'), 'approved');
  const snapshot = { digest: `sha256:${'a'.repeat(64)}`, workspace: `sha256:${'a'.repeat(64)}` };
  const server = String.raw`
let calls=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!('id' in m))return;let result;
 if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'tools-probe',version:'1'}};
 else if(m.method==='tools/list')result={tools:[{name:'lookup',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{choice:{type:'string',enum:['allowed','wait']}},required:['choice'],additionalProperties:false}},{name:'unapproved',inputSchema:{type:'object'}}]};
 else {if(m.params.arguments.choice==='wait')return;result={content:[{type:'text',text:process.env.ZHIVEX_MCP_TOKEN}],structuredContent:{calls:++calls}};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n')});`.replace(/\n/g, ' ');
  const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: image.RepoDigests[0],
    executable: '/usr/local/bin/node', args: ['-e', server], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: snapshot.digest,
    scope: { principal: 'smoke', tenant: 'local', session: 'smoke', workspace: snapshot.workspace }, includeTools: ['lookup'], permissions: ['read'],
    environment: { ZHIVEX_MCP_TOKEN: 'CLIENT_ENV_CANARY' }, secretReferences: {}, limits: { sessionMs: 30000, callMs: 5000, memoryMb: 128,
      maxCpus: 0.5, maxPids: 32, maxWorkspaceBytes: 1024 * 1024, maxFileWriteBytes: 4096, tmpfsMb: 1, maxOutputBytes: 128 * 1024 } };

  let admissions = 0, runId = '';
  const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'acp-smoke', maximumLimits: proposal.limits,
    authorize: async reviewed => { admissions++; runId = reviewed.scope.session; return true; } });
  host = await createAcpMcpHost({ harness: { workspace: root, stateDirectory: config.stateDirectory, tenantId: 'local', userId: 'smoke', store: persistence.store, subagentProfiles: [],
    modelInstance: createMockLanguageModel({ streamEvents: [[
      { type: 'tool-call', toolCall: { id: 'docs', name: 'mcp_docs_lookup', input: { choice: 'allowed' } } },
      { type: 'tool-call', toolCall: { id: 'extra', name: 'mcp_extra_lookup', input: { choice: 'allowed' } } },
      { type: 'finish', finishReason: 'tool-calls' }
    ], [{ type: 'text-delta', textDelta: 'MCP completed' }, { type: 'finish', finishReason: 'stop' }]] }) },
    rules: ['docs', 'extra'].map(serverId => ({ clientName: serverId, clientCommand: `/client/${serverId}`, clientArgs: [],
      proposal: { ...proposal, serverId, environment: {} }, environmentBindings: { CLIENT_TOKEN: 'ZHIVEX_MCP_TOKEN' } })),
    authority, provisionerImageId: image.Id, hostId: 'acp-smoke-host', resolveSecret: async () => undefined });
  const notifications: unknown[] = []; let permissions = 0;
  const sdkClient = process.argv.includes('--sdk-client');
  if (sdkClient) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./acp-mcp-sdk-client.ts', import.meta.url)), host.workspace], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH }
    });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 90_000);
    try {
      await serveAcpStdio(host.adapter, { workspace: host.workspace, mcpSessionProvider: host.mcpSessionProvider,
        input: child.stdout, output: child.stdin, permissionTimeoutMs: 30_000 });
      assert.equal(await exited, 0, diagnostics);
      assert.deepEqual(JSON.parse(diagnostics), { status: 'passed', client: '@agentclientprotocol/sdk@1.5.1', permissions: 2 });
    } finally { clearTimeout(deadline); child.kill(); }
  } else {
  const connection = createAcpConnection(host.adapter, { workspace: host.workspace, mcpSessionProvider: host.mcpSessionProvider,
    notify: message => { notifications.push(message); }, requestPermission: async () => {
      permissions++;
      assert.equal((await persistence.store.listToolCalls!(runId, config.scope)).filter(row => row.toolName === 'isolated_mcp_call').length, 0);
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    } });
  let seq = 0;
  const call = (method: string, params: unknown) => connection.handle({ jsonrpc: '2.0', id: ++seq, method, params }) as Promise<any>;
  assert.equal((await call('initialize', { protocolVersion: 1 })).result._meta.zhivex.clientMcp, true);
  const session = await call('session/new', { cwd: host.workspace, mcpServers: ['docs', 'extra'].map(name => ({ name, command: `/client/${name}`, args: [],
    env: [{ name: 'CLIENT_TOKEN', value: 'CLIENT_ENV_CANARY' }] })) });
  assert.ok(session.result?.sessionId);
  const result = await call('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'Use both MCP tools' }] });
  assert.deepEqual(result.result, { stopReason: 'end_turn' }); assert.equal(permissions, 2);
  }
  assert.equal(admissions, 4);
  const rows = await persistence.store.listToolCalls!(runId, config.scope);
  const calls = rows.filter(row => row.toolName === 'isolated_mcp_call');
  assert.equal(calls.length, 2); assert.ok(calls.every(row => row.status === 'completed'));
  assert.equal(JSON.stringify(await persistence.store.load(runId, config.scope)).includes('CLIENT_ENV_CANARY'), false);
  assert.equal(JSON.stringify(notifications).includes('CLIENT_ENV_CANARY'), false);
  await host.close(); host = undefined;
  assert.deepEqual(await owned(), baseline);
  console.log(JSON.stringify({ status: 'passed', checks: ['acp-session-registration', 'two-real-servers', 'fresh-host-admission-per-invocation',
    'two-client-permissions-before-effects', 'two-durable-calls', 'client-env-redacted', 'cleanup-confirmed'],
    scope: sdkClient ? 'Independent official ACP SDK 1.5.1 client process over stdio with real Docker servers; fixture model, no editor certification'
      : 'In-process ACP request fixture with real Docker and durable adapter; independent ACP client acceptance remains pending' }, null, 2));
} finally { await host?.close(); persistence.close(); await rm(root, { recursive: true, force: true }); }
