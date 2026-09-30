import { launchDockerMcpServer } from '../src/execution/mcp-oci-server.js';
import { prepareMcpWorkspaceSnapshot } from '../src/execution/mcp-workspace-snapshot.js';
import { Workspace } from '../src/workspace/workspace.js';
import { createMcpStdioAdmissionAuthority } from '../src/integrations/mcp-stdio-admission.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { reserveMcpResources } from '../src/persistence/mcp-resource-journal.js';
import { recoverDockerMcpResources } from '../src/execution/mcp-resource-recovery.js';
import { runPortableProcess } from '../src/execution/process-runtime.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
  .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
async function docker(args: string[]) {
  const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 10000, maxOutputCharacters: 1024 * 1024 });
  assert.equal(result.exitCode, 0, 'Recovery smoke Docker operation failed'); assert.equal(result.timedOut, false);
  return result.stdout.trim();
}
const digest = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'docs', boundary: 'oci', image: `example/server@${digest}`,
  executable: '/server', args: [], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: digest,
  scope: { principal: 'operator', tenant: 'tenant', session: 'recovery-smoke', workspace: digest }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1024, maxFileWriteBytes: 1024, tmpfsMb: 1, maxOutputBytes: 4096 } };
const childMode = process.argv[2] === '--child';
const activeMode = process.argv.includes('--active');
const root = childMode ? process.argv[3]! : await mkdtemp(path.join(tmpdir(), 'zhx-mcp-recovery-'));
const config = resolveHarnessConfig({ workspace: root, stateDirectory: path.join(root, '.zhivex-harness'), storeBackend: 'sqlite', tenantId: 'tenant', userId: 'operator' });
if (childMode) {
  const persistence = await openHarnessPersistence(config);
  await persistence.store.save({ schemaVersion: 1, revision: 0, runId: 'recovery-smoke', scope: config.scope, provider: 'fixture', modelId: 'fixture', status: 'running',
    messages: [], steps: [], toolResults: [], outputText: '', currentStep: 0, maxSteps: 5, pendingApprovals: [], compactions: [], startedAt: Date.now(), updatedAt: Date.now() });
  const image = JSON.parse(await docker(['image', 'inspect', process.env.HARNESS_MCP_SMOKE_IMAGE ?? 'node:22-alpine']))[0];
  if (activeMode) {
    const snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
    const server = String.raw`
const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
const ready=new Promise(resolve=>child.stdout.once('data',resolve));
require('node:fs').writeFileSync('/tmp/descendant',String(child.pid));
setInterval(()=>{},1000);
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);if(!('id' in m))return;await ready;let result;
 if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'crash-probe',version:'1'}};
 else {process.kill(child.pid,0);result={content:[{type:'text',text:'descendant-alive'}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});`.replace(/\n/g, ' ');
    const admitted: McpStdioLaunchProposal = { ...proposal, image: image.RepoDigests[0], executable: '/usr/local/bin/node', args: ['-e', server],
      snapshotDigest: snapshot.digest, scope: { ...proposal.scope, workspace: snapshot.workspace },
      limits: { ...proposal.limits, maxPids: 64, sessionMs: 60000, callMs: 5000, maxWorkspaceBytes: 1024 * 1024, maxOutputBytes: 128 * 1024 } };
    const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'recovery-smoke', maximumLimits: admitted.limits, authorize: async () => true });
    const receipt = await authority.admit(admitted);
    const client = await launchDockerMcpServer({ authority, receipt, proposal: admitted, snapshot, scope: admitted.scope, provisionerImageId: image.Id,
      resourceJournal: { store: persistence.store, runId: 'recovery-smoke', scope: config.scope, hostId: 'recovery-smoke-host' }, resolveSecret: async () => undefined });
    assert.deepEqual(await client.callTool({ name: 'lookup', arguments: {} }), { content: [{ type: 'text', text: 'descendant-alive' }] });
    process.exit(23);
  }
  const lease = await reserveMcpResources({ store: persistence.store, runId: 'recovery-smoke', scope: config.scope, hostId: 'recovery-smoke-host',
    daemonId: await docker(['info', '--format', '{{.ID}}']), proposal, serverImageId: image.Id, provisionerImageId: image.Id });
  await lease.advance('provisioning');
  const labels = Object.entries(lease.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  await docker(['volume', 'create', ...labels, lease.plan.volumeName]);
  for (const name of [lease.plan.serverName, lease.plan.seederName]) {
    await docker(['create', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '65532:65532', ...labels,
      '--mount', `type=volume,src=${lease.plan.volumeName},dst=/workspace`, image.Id, 'true']);
  }
  // Terminate without releasing the resources or closing SQLite: simulate a host
  // crash after Docker accepted creation, before protocol startup.
  process.exit(23);
}
const unrelated = `zhx-recovery-control-${randomUUID()}`;
let persistence: Awaited<ReturnType<typeof openHarnessPersistence>> | undefined;
try {
  await docker(['volume', 'create', unrelated]);
  const child = Bun.spawn([process.execPath, import.meta.path, '--child', root, ...(activeMode ? ['--active'] : [])], { stdout: 'ignore', stderr: 'pipe' });
  const exitCode = await child.exited;
  if (exitCode !== 23) console.error((await new Response(child.stderr).text()).slice(0, 4000));
  persistence = await openHarnessPersistence(config);
  assert.equal(exitCode, 23, 'Fixture must reach its deliberate termination');
  const rows = await persistence.store.listToolCalls!('recovery-smoke', config.scope);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0]?.output, { schemaVersion: 1, phase: activeMode ? 'ready' : 'provisioning' });
  if (activeMode) {
    const plan = rows[0]!.input as { serverName: string };
    assert.equal(JSON.parse(await docker(['inspect', plan.serverName]))[0].State.Running, true);
    await docker(['exec', plan.serverName, '/usr/local/bin/node', '-e', "process.kill(Number(require('node:fs').readFileSync('/tmp/descendant','utf8')),0)"]);
  }
  const options = { store: persistence.store, runId: 'recovery-smoke', scope: config.scope, hostId: 'recovery-smoke-host' };
  assert.deepEqual(await recoverDockerMcpResources(options), { closed: 1, deferred: 0 });
  const recovered = await persistence.store.listToolCalls!('recovery-smoke', config.scope);
  assert.deepEqual(recovered[0]?.output, { schemaVersion: 1, phase: 'closed' });
  assert.equal(recovered[0]?.status, 'completed');
  assert.deepEqual(await recoverDockerMcpResources(options), { closed: 0, deferred: 0 });
  assert.equal(JSON.parse(await docker(['volume', 'inspect', unrelated]))[0].Name, unrelated);
  console.log(JSON.stringify({ status: 'passed', checks: ['abrupt-owner-exit', 'sqlite-reopen', activeMode ? 'active-server-and-descendant-recovery' : 'partial-provisioning-recovery', 'persisted-closure', 'idempotent-recovery', 'unrelated-volume-preserved'],
    scope: activeMode ? 'Real admitted MCP server and live descendant recovered after host exit; automatic agent startup integration remains pending' : 'Real Docker recovery after creation before startup' }, null, 2));
} finally {
  // Scoped recovery is also the fixture cleanup path on an assertion failure.
  if (persistence) { await recoverDockerMcpResources({ store: persistence.store, runId: 'recovery-smoke', scope: config.scope, hostId: 'recovery-smoke-host' }); persistence.close(); }
  await docker(['volume', 'rm', unrelated]);
  await rm(root, { recursive: true, force: true });
}
