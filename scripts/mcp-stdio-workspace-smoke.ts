import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { prepareMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot } from '../src/execution/mcp-workspace-snapshot.js';
import { createDockerMcpWorkspace, type DockerMcpWorkspaceLease } from '../src/execution/mcp-oci-workspace.js';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
import { withAdmittedMcpLaunch } from '../src/integrations/mcp-stdio-launch.js';
import { openDockerMcpChannel } from '../src/execution/mcp-oci-channel.js';
import { IsolatedMcpStdioClient } from '../src/integrations/mcp-stdio-client.js';
import { runPortableProcess } from '../src/execution/process-runtime.js';

const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
  .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
async function docker(args: string[]) {
  const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 30_000, maxOutputCharacters: 64 * 1024 });
  assert.equal(result.exitCode, 0, `Docker workspace smoke failed: ${args[0]}`);
  assert.equal(result.timedOut, false); return result.stdout.trim();
}
const inspected = JSON.parse(await docker(['image', 'inspect', process.env.HARNESS_MCP_SMOKE_IMAGE ?? 'node:22-alpine']))[0];
const imageId: string = inspected.Id;
const image: string = inspected.RepoDigests[0];
const root = await mkdtemp(path.join(tmpdir(), 'zhx-mcp-workspace-smoke-'));
let lease: DockerMcpWorkspaceLease | undefined;
let client: IsolatedMcpStdioClient | undefined;
let container: string | undefined;
let snapshot: Awaited<ReturnType<typeof prepareMcpWorkspaceSnapshot>> | undefined;
try {
  const approved = 'approved snapshot\n'.repeat(8000);
  await writeFile(path.join(root, 'data.txt'), approved);
  await writeFile(path.join(root, '.env'), 'not-for-server');
  snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
  const server = String.raw`
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if (!('id' in m)) return;
 let result;
 if(m.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'snapshot-probe',version:'1'}};
 else {
  let readOnly=false; try{fs.writeFileSync('/workspace/new.txt','forbidden')}catch{readOnly=true}
  result={structuredContent:{data:fs.readFileSync('/workspace/data.txt','utf8'),secretAbsent:!fs.existsSync('/workspace/.env'),readOnly}};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
});`.replace(/\n/g, ' ');
  const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'snapshot', boundary: 'oci', image,
    executable: '/usr/local/bin/node', args: ['-e', server], protocolVersion: '2025-11-25', workingDirectory: '.',
    snapshotDigest: snapshot.digest, scope: { principal: 'smoke', tenant: 'local', session: 'smoke', workspace: snapshot.workspace },
    includeTools: ['probe'], permissions: ['read'], environment: {}, secretReferences: {},
    limits: { sessionMs: 30_000, callMs: 5000, memoryMb: 128, maxCpus: 0.5, maxPids: 32,
      maxWorkspaceBytes: 1024 * 1024, maxFileWriteBytes: 65536, tmpfsMb: 16, maxOutputBytes: 1024 * 1024 } };
  const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'smoke-v1', maximumLimits: proposal.limits, authorize: async () => true });
  const receipt = await authority.admit(proposal);
  await writeFile(path.join(root, 'data.txt'), 'changed after approval');
  await withAdmittedMcpLaunch({ authority, receipt, proposal, snapshot, scope: { ...proposal.scope },
    resolveSecret: async () => { throw new Error('No secrets should be requested'); },
    seed: async ({ files, proposal: admitted }) => { lease = await createDockerMcpWorkspace({ provisionerImageId: imageId, proposal: admitted, files }); } });
  assert.ok(lease);
  container = await docker(['create', '--pull', 'never', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '32', '--cpus', '0.5', '--user', '65532:65532',
    '--label', 'com.zhivex.harness.mcp=v1', '--label', `com.zhivex.harness.owner-pid=${process.pid}`,
    '--mount', `type=volume,src=${lease.volumeName},dst=/workspace,readonly,volume-nocopy`,
    '--entrypoint', proposal.executable, imageId, ...proposal.args]);
  const channel = await openDockerMcpChannel({ containerId: container, imageId, sessionMs: 30_000, maxOutputBytes: 1024 * 1024 });
  client = new IsolatedMcpStdioClient(channel, { callMs: 5000, initializeMs: 5000, sessionMs: 30_000, maxFrameBytes: 512 * 1024, closeMs: 35_000 });
  await client.initialize();
  await lease.stopSeeder(); // Server now holds the same tmpfs mount.
  const result = await client.callTool({ name: 'probe' });
  assert.deepEqual(result.structuredContent, { data: approved, secretAbsent: true, readOnly: true });
  await client.close(); await lease.close();
  assert.equal(await docker(['volume', 'ls', '--quiet', '--filter', `name=${lease.volumeName}`]), '');
  assert.equal(await docker(['ps', '--all', '--quiet', '--filter', `id=${container}`]), '');
  const owned = async () => ({
    containers: await docker(['ps', '--all', '--quiet', '--filter', 'label=com.zhivex.harness.mcp=v1', '--filter', `label=com.zhivex.harness.owner-pid=${process.pid}`]),
    volumes: await docker(['volume', 'ls', '--quiet', '--filter', 'label=com.zhivex.harness.mcp=v1', '--filter', `label=com.zhivex.harness.owner-pid=${process.pid}`])
  });
  const baseline = await owned();
  for (const invalid of ['traversal', 'duplicate', 'overflow'] as const) {
    async function* files() {
      const contents = new Uint8Array(invalid === 'overflow' ? proposal.limits.maxWorkspaceBytes + 1 : 1);
      yield { path: invalid === 'traversal' ? '../outside' : 'same.txt', contents, executable: false };
      if (invalid === 'duplicate') yield { path: 'same.txt', contents, executable: false };
    }
    await assert.rejects(createDockerMcpWorkspace({ provisionerImageId: imageId, proposal, files: files() }), /provisioning failed/);
    assert.deepEqual(await owned(), baseline, `${invalid} must leave no seeder or volume`);
  }
  console.log(JSON.stringify({ status: 'passed', imageId, files: snapshot.files, bytes: snapshot.bytes,
    checks: ['admission-before-volume', 'chunked-snapshot-seed', 'approved-bytes-after-host-change', 'sensitive-file-excluded', 'read-only-server-mount', 'seeder-to-server-mount-handoff', 'container-and-volume-removed', 'traversal-rejected-clean', 'duplicate-rejected-clean', 'overflow-rejected-clean'],
    scope: 'Real source workspace provisioning; server creation is still a smoke fixture, not the complete production launch coordinator' }, null, 2));
} finally {
  await client?.close().catch(() => {});
  if (container) await runPortableProcess(['docker', 'rm', '--force', container], { env, timeoutMs: 10_000, maxOutputCharacters: 1024 });
  await lease?.close();
  if (snapshot) await discardMcpWorkspaceSnapshot(snapshot);
  await rm(root, { recursive: true, force: true });
}
