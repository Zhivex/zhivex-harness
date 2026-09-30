import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { prepareMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot } from '../src/execution/mcp-workspace-snapshot.js';
import { launchDockerMcpServer } from '../src/execution/mcp-oci-server.js';
import { createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
import { runPortableProcess } from '../src/execution/process-runtime.js';

const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
  .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
async function docker(args: string[]) {
  const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 30_000, maxOutputCharacters: 64 * 1024 });
  assert.equal(result.exitCode, 0, `Docker launch smoke failed: ${args[0]}`);
  assert.equal(result.timedOut, false); return result.stdout.trim();
}
const image = JSON.parse(await docker(['image', 'inspect', process.env.HARNESS_MCP_SMOKE_IMAGE ?? 'node:22-alpine']))[0];
const owned = async () => ({
  containers: await docker(['ps', '--all', '--quiet', '--filter', 'label=com.zhivex.harness.mcp=v1', '--filter', `label=com.zhivex.harness.owner-pid=${process.pid}`]),
  volumes: await docker(['volume', 'ls', '--quiet', '--filter', 'label=com.zhivex.harness.mcp=v1', '--filter', `label=com.zhivex.harness.owner-pid=${process.pid}`])
});
const baseline = await owned();
const results = [];
for (const writable of [false, true]) {
  const root = await mkdtemp(path.join(tmpdir(), 'zhx-mcp-launch-smoke-'));
  let snapshot: Awaited<ReturnType<typeof prepareMcpWorkspaceSnapshot>> | undefined;
  let client: Awaited<ReturnType<typeof launchDockerMcpServer>> | undefined;
  try {
    await writeFile(path.join(root, 'input.txt'), 'approved data');
    snapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), 1024 * 1024);
    const server = String.raw`
const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!('id' in m))return;let result;
 if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'launch-probe',version:'1'}};
 else{if(m.params?.name==='wait')return;let wrote=false,oversizeDenied=false;try{fs.writeFileSync('/workspace/output.txt','isolated');wrote=true}catch{}
 try{fs.writeFileSync('/tmp/too-large',Buffer.alloc(4097))}catch{oversizeDenied=true}
 result={structuredContent:{data:fs.readFileSync('/workspace/input.txt','utf8'),wrote,oversizeDenied,
 secretGranted:process.env.ZHIVEX_MCP_TOKEN==='fixture-value',imageDefaultsAbsent:!('NODE_VERSION' in process.env)&&!('YARN_VERSION' in process.env),
 hostPathAbsent:!('PATH' in process.env),envKeys:Object.keys(process.env).sort(),cwd:process.cwd()}}}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n')});`.replace(/\n/g, ' ');
    const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'launch', boundary: 'oci', image: image.RepoDigests[0],
      executable: '/usr/local/bin/node', args: ['-e', server], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: snapshot.digest,
      scope: { principal: 'smoke', tenant: 'local', session: 'smoke', workspace: snapshot.workspace }, includeTools: ['probe', 'wait'],
      permissions: writable ? ['read', 'write'] : ['read'], environment: {}, secretReferences: { ZHIVEX_MCP_TOKEN: 'fixture' },
      limits: { sessionMs: 30_000, callMs: 5000, memoryMb: 128, maxCpus: 0.5, maxPids: 32, maxWorkspaceBytes: 1024 * 1024,
        maxFileWriteBytes: 4096, tmpfsMb: 1, maxOutputBytes: 128 * 1024 } };
    const authority = createMcpStdioAdmissionAuthority({ policyVersion: 'smoke-v1', maximumLimits: proposal.limits, authorize: async () => true });
    const receipt = await authority.admit(proposal);
    client = await launchDockerMcpServer({ authority, receipt, proposal, snapshot, scope: { ...proposal.scope },
      resolveSecret: async reference => { assert.equal(reference, 'fixture'); return 'fixture-value'; }, provisionerImageId: image.Id });
    const response = await client.callTool({ name: 'probe' });
    assert.deepEqual(response.structuredContent, { data: 'approved data', wrote: writable, oversizeDenied: true,
      secretGranted: true, imageDefaultsAbsent: true, hostPathAbsent: true,
      envKeys: ['HOME', 'HOSTNAME', 'LANG', 'TMPDIR', 'ZHIVEX_MCP_TOKEN'], cwd: '/workspace' });
    if (writable) {
      const controller = new AbortController();
      const calling = client.callTool({ name: 'wait' }, { abortSignal: controller.signal }).catch(error => error);
      const timer = setTimeout(() => controller.abort(), 100);
      try { const failure = await calling; assert.equal(failure.code, 'cancelled'); assert.equal(failure.outcomeUnknown, true); }
      finally { clearTimeout(timer); }
    }
    await client.close();
    assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'approved data');
    await assert.rejects(access(path.join(root, 'output.txt')));
    assert.deepEqual(await owned(), baseline);
    results.push({ permissions: writable ? 'read-write' : 'read-only', status: 'passed', cleanup: 'confirmed' });
    if (writable) {
      for (const failure of ['forged-admission', 'missing-secret', 'startup-exit']) {
        const nextSnapshot = await prepareMcpWorkspaceSnapshot(await Workspace.open(root), proposal.limits.maxWorkspaceBytes);
        const nextProposal = { ...proposal, snapshotDigest: nextSnapshot.digest,
          args: failure === 'startup-exit' ? ['-e', 'process.exit(17)'] : proposal.args };
        const nextReceipt = await authority.admit(nextProposal);
        try {
          await assert.rejects(launchDockerMcpServer({ authority, receipt: failure === 'forged-admission' ? {} : nextReceipt,
            proposal: nextProposal, snapshot: nextSnapshot, scope: { ...proposal.scope }, provisionerImageId: image.Id,
            resolveSecret: async () => failure === 'missing-secret' ? undefined : 'fixture-value' }), /launch failed/);
          assert.deepEqual(await owned(), baseline, `${failure} must leave no resources`);
        } finally { await discardMcpWorkspaceSnapshot(nextSnapshot); }
      }
    }
  } finally {
    await client?.close();
    if (snapshot) await discardMcpWorkspaceSnapshot(snapshot);
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ status: 'passed', imageId: image.Id, results,
  checks: ['admitted-launch', 'exact-environment', 'secret-reference-injection', 'image-environment-unset', 'host-path-not-inherited', 'workspace-permissions', 'host-unchanged', 'per-file-write-limit', 'forged-admission-rejected', 'missing-secret-rejected', 'startup-failure-cleaned', 'cancelled-call-unknown-outcome', 'all-owned-resources-removed'],
  scope: 'Internal source launch coordinator; per-tool approval, durable audit and installed acceptance remain pending' }, null, 2));
