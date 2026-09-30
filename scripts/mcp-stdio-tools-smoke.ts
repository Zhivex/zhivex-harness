import { createHash } from 'node:crypto';
import { createMcpReconciliationAuthority } from '../src/persistence/mcp-reconciliation.js';
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
const persistence = await openHarnessPersistence(config);
let snapshot: Awaited<ReturnType<typeof prepareMcpWorkspaceSnapshot>> | undefined;
let session: Awaited<ReturnType<typeof launchDockerMcpTools>> | undefined;
try {
  await persistence.store.save({ schemaVersion: 1, revision: 0, runId: 'smoke', scope: config.scope, provider: 'fixture', modelId: 'fixture', status: 'running',
    messages: [], steps: [], toolResults: [], outputText: '', currentStep: 0, maxSteps: 5, pendingApprovals: [], compactions: [], startedAt: Date.now(), updatedAt: Date.now() });
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
  const concurrentSnapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
  await assert.rejects(launchDockerMcpTools({ authority, receipt, proposal, snapshot: concurrentSnapshot, scope: proposal.scope, provisionerImageId: image.Id,
    journal: { hostId: 'local-smoke-host', store: persistence.store, runId: 'smoke', scope: config.scope }, resolveSecret: async () => 'SENSITIVE_FIXTURE_VALUE' }),
    /requires confirmed recovery/);
  assert.deepEqual(Object.keys(session.tools), ['mcp_docs_lookup']);
  const tool = session.tools.mcp_docs_lookup;
  assert.ok(tool && 'execute' in tool);
  assert.equal(tool.requiresApproval, true); assert.equal(tool.approvalMode, 'interrupt');
  // Explicit test-host invocation: checks tool behavior, not agent durable approval resumption.
  const context = { idempotencyKey: 'approved-smoke-call', runId: 'smoke', scope: config.scope, step: 0,
    toolCall: { id: 'call', name: 'mcp_docs_lookup', input: { choice: 'allowed' } },
    model: { provider: 'fixture', modelId: 'fixture', capabilities: { streaming: false, tools: true, structuredOutput: false,
      jsonMode: false, toolChoice: false, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
      async generate(): Promise<never> { throw new Error('This fixture does not invoke a model.'); } } };
  await assert.rejects(tool.execute({ choice: 'invalid' } as never, context), /validation/);
  await assert.rejects(tool.execute({ choice: 'allowed' } as never, { ...context, runId: 'foreign' }), /scope/);
  const response = await tool.execute({ choice: 'allowed' } as never, context);
  assert.deepEqual(response, { content: [{ type: 'text', text: '[REDACTED]' }], structuredContent: { calls: 1 } });
  await assert.rejects(tool.execute({ choice: 'allowed' } as never, context), /replay_denied/);
  const rows = await persistence.store.listToolCalls!('smoke', config.scope);
  const journal = rows.filter(entry => entry.toolName === 'isolated_mcp_call');
  assert.deepEqual(rows.find(entry => entry.toolName === 'isolated_mcp_resources')?.output, { schemaVersion: 1, phase: 'ready' });
  assert.equal(journal.length, 1); assert.equal(journal[0]?.status, 'completed');
  assert.equal(JSON.stringify(journal).includes('SENSITIVE_FIXTURE_VALUE'), false);
  const controller = new AbortController();
  const pending = tool.execute({ choice: 'wait' } as never, { ...context, idempotencyKey: 'approved-wait-call', abortSignal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending); } finally { clearTimeout(timer); }
  await session.close();
  const interrupted = await persistence.store.listToolCalls!('smoke', config.scope);
  assert.equal(interrupted.length, 3);
  assert.deepEqual(interrupted.find(entry => entry.toolName === 'isolated_mcp_resources')?.output, { schemaVersion: 1, phase: 'closed' });
  assert.ok(interrupted.some(entry => entry.status === 'failed' && entry.error?.message === 'MCP_OUTCOME_UNKNOWN'));
  await assert.rejects(tool.execute({ choice: 'allowed' } as never, { ...context, idempotencyKey: 'new-key' }), /outcome_unknown/);
  assert.deepEqual(await owned(), baseline);
  const unknown = interrupted.find(entry => entry.toolName === 'isolated_mcp_call' && entry.error?.message === 'MCP_OUTCOME_UNKNOWN')!;
  const reconciliation = createMcpReconciliationAuthority({ store: persistence.store, runId: 'smoke', scope: config.scope, hostId: 'local-smoke-host',
    // Explicit fixture-host decision: the known wait handler returns without
    // modifying state. This is not evidence of a user-facing review UI.
    authorize: async review => review.outcome === 'no_effect_confirmed' && review.toolCallId === unknown.toolCallId });
  await reconciliation.reconcile({ toolCallId: unknown.toolCallId, expectedRevision: unknown.revision, outcome: 'no_effect_confirmed',
    evidenceDigest: `sha256:${createHash('sha256').update(server).digest('hex')}` });
  snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
  const newReceipt = await authority.admit(proposal);
  session = await launchDockerMcpTools({ authority, receipt: newReceipt, proposal, snapshot, scope: proposal.scope, provisionerImageId: image.Id,
    journal: { hostId: 'local-smoke-host', store: persistence.store, runId: 'smoke', scope: config.scope }, resolveSecret: async () => 'SENSITIVE_FIXTURE_VALUE' });
  const freshTool = session.tools.mcp_docs_lookup;
  assert.ok(freshTool && 'execute' in freshTool);
  await assert.rejects(freshTool.execute({ choice: 'wait' } as never, { ...context, idempotencyKey: 'approved-wait-call' }), /replay_denied/);
  const freshResponse = await freshTool.execute({ choice: 'allowed' } as never, { ...context, idempotencyKey: 'separately-approved-after-reconciliation' });
  assert.deepEqual(freshResponse, { content: [{ type: 'text', text: '[REDACTED]' }], structuredContent: { calls: 1 } });
  await session.close();
  assert.deepEqual(await owned(), baseline);
  console.log(JSON.stringify({ status: 'passed', imageId: image.Id,
    checks: ['allowlist-only-tools', 'untrusted-read-only-hint-keeps-interrupt-approval', 'invalid-arguments-not-dispatched', 'secret-result-redacted', 'one-valid-dispatch', 'durable-claim-and-completion', 'duplicate-dispatch-denied', 'journal-has-no-secret', 'cancelled-call-durable-unknown-outcome', 'new-key-cannot-bypass-reconciliation', 'cleanup-confirmed', 'resource-reservation-durable', 'resource-closure-durable', 'startup-rejects-live-prior-owner', 'host-reconciliation-after-cleanup', 'reconciled-key-still-unreplayable', 'fresh-admitted-call-after-resolution'],
    scope: 'Internal source bridge with explicit fixture-host reconciliation; harness approval is verified separately; installed acceptance remains pending' }, null, 2));
} finally {
  await session?.close();
  if (snapshot) await discardMcpWorkspaceSnapshot(snapshot);
  persistence.close();
  await rm(root, { recursive: true, force: true });
}
