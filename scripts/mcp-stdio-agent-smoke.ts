import { createHarness, runHarness } from '../src/runtime/harness.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { prepareMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot } from '../src/execution/mcp-workspace-snapshot.js';
import { launchDockerMcpTools } from '../src/execution/mcp-oci-server.js';
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
let persistence = await openHarnessPersistence(config);
let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
let snapshot: Awaited<ReturnType<typeof prepareMcpWorkspaceSnapshot>> | undefined;
let session: Awaited<ReturnType<typeof launchDockerMcpTools>> | undefined;
try {
  await writeFile(path.join(root, 'data'), 'approved');
  snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
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
    environment: {}, secretReferences: { ZHIVEX_MCP_TOKEN: 'fixture' }, limits: { sessionMs: 30000, callMs: 5000, memoryMb: 128,
      maxCpus: 0.5, maxPids: 32, maxWorkspaceBytes: 1024 * 1024, maxFileWriteBytes: 4096, tmpfsMb: 1, maxOutputBytes: 128 * 1024 } };
  const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'smoke-v1', maximumLimits: proposal.limits, authorize: async () => true });
  const receipt = await authority.admit(proposal);
  session = await launchDockerMcpTools({ authority, receipt, proposal, snapshot, scope: { ...proposal.scope }, provisionerImageId: image.Id,
    journal: { hostId: 'local-smoke-host', store: persistence.store, runId: 'smoke', scope: config.scope },
    resolveSecret: async () => 'SENSITIVE_FIXTURE_VALUE' });
  const create = (resuming = false) => createHarness({ workspace: root, stateDirectory: config.stateDirectory,
    tenantId: 'local', userId: 'smoke', store: persistence.store, isolatedMcpSession: session!.hostSession, subagentProfiles: [],
    modelInstance: createMockLanguageModel({ streamEvents: resuming ? [
      [{ type: 'text-delta', textDelta: 'MCP completed' }, { type: 'finish', finishReason: 'stop' }]
    ] : [[{ type: 'tool-call', toolCall: { id: 'lookup-call', name: 'mcp_docs_lookup', input: { choice: 'allowed' } } },
      { type: 'finish', finishReason: 'tool-calls' }]] }) });
  harness = await create();
  await assert.rejects(runHarness(harness, { runId: 'foreign', prompt: 'lookup' }), /does not match/);
  const waiting = await runHarness(harness, { runId: 'smoke', prompt: 'Use lookup' });
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.state.pendingApprovals.length, 1);
  assert.equal(waiting.state.pendingApprovals[0]?.name, 'mcp_docs_lookup');
  assert.equal((await persistence.store.listToolCalls!('smoke', config.scope)).filter(row => row.toolName === 'isolated_mcp_call').length, 0);
  await harness.close(); harness = undefined;
  persistence.close(); persistence = await openHarnessPersistence(config);
  const saved = await persistence.store.load('smoke', config.scope);
  assert.ok(saved); assert.equal(saved.status, 'waiting_approval');
  snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
  assert.equal(snapshot.digest, proposal.snapshotDigest);
  const resumeReceipt = await authority.admit(proposal);
  session = await launchDockerMcpTools({ authority, receipt: resumeReceipt, proposal, snapshot, scope: proposal.scope, provisionerImageId: image.Id,
    journal: { hostId: 'local-smoke-host', store: persistence.store, runId: 'smoke', scope: config.scope }, resolveSecret: async () => 'SENSITIVE_FIXTURE_VALUE' });
  harness = await create(true);
  const completed = await runHarness(harness, { state: saved, approvals: saved.pendingApprovals.map(approval => ({
    provider: approval.provider, approvalRequestId: approval.id, approve: true
  })) });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputText, 'MCP completed');
  const calls = (await persistence.store.listToolCalls!('smoke', config.scope)).filter(row => row.toolName === 'isolated_mcp_call');
  assert.equal(calls.length, 1); assert.equal(calls[0]?.status, 'completed');
  assert.equal(JSON.stringify(completed).includes('SENSITIVE_FIXTURE_VALUE'), false);
  await harness.close(); harness = undefined;
  assert.deepEqual(await owned(), baseline);
  console.log(JSON.stringify({ status: 'passed', checks: ['host-session-binding', 'agent-pauses-before-dispatch', 'sqlite-reopen',
    'fresh-mcp-session', 'persisted-approval-resume', 'single-journaled-dispatch', 'secret-redacted', 'harness-close-removes-resources'],
    scope: 'Real OCI MCP with fixture language model and actual harness approval/resume; installed acceptance remains pending' }, null, 2));
} finally {
  await harness?.close();
  await session?.close();
  if (snapshot) await discardMcpWorkspaceSnapshot(snapshot);
  persistence.close();
  await rm(root, { recursive: true, force: true });
}
