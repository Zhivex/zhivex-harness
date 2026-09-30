import assert from 'node:assert/strict';
import { openDockerMcpChannel } from '../src/execution/mcp-oci-channel.js';
import { IsolatedMcpStdioClient } from '../src/integrations/mcp-stdio-client.js';
import { runPortableProcess } from '../src/execution/process-runtime.js';

const image = process.env.HARNESS_MCP_SMOKE_IMAGE ?? 'node:22-alpine';
async function docker(args: string[]) {
  const result = await runPortableProcess(['docker', ...args], { timeoutMs: 30_000, maxOutputCharacters: 64 * 1024 });
  assert.equal(result.exitCode, 0, 'Docker smoke operation failed');
  assert.equal(result.timedOut, false); return result.stdout.trim();
}
const imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
const server = `
const readline = require('node:readline'); const fs = require('node:fs');
readline.createInterface({ input: process.stdin }).on('line', async line => {
 const m = JSON.parse(line); if (!('id' in m)) return;
 let result;
 if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1' } };
 else if (m.method === 'tools/list') result = { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] };
 else {
  let rootDenied = false; try { fs.writeFileSync('/root-write-probe', 'x'); } catch { rootDenied = true; }
  let networkDenied = false; try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(250) }); } catch { networkDenied = true; }
  result = { structuredContent: { uid: process.getuid(), rootDenied, networkDenied } };
 }
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`;
// An unlabelled/default-policy container must be rejected without starting it.
const denied = await docker(['create', '--entrypoint', 'node', imageId, '-e', 'process.exit(0)']);
try {
  await assert.rejects(openDockerMcpChannel({ containerId: denied, imageId, sessionMs: 1000, maxOutputBytes: 1024 }), /not attested/);
  assert.equal(await docker(['inspect', denied, '--format', '{{.State.Status}}']), 'created');
} finally { await docker(['rm', '--force', denied]); }
const id = await docker(['create', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '16', '--cpus', '0.5',
  '--user', '65532:65532', '--label', 'com.zhivex.harness.mcp=v1',
  '--label', `com.zhivex.harness.owner-pid=${process.pid}`, '--entrypoint', 'node', imageId, '-e', server]);
let client: IsolatedMcpStdioClient | undefined;
try {
  const channel = await openDockerMcpChannel({ containerId: id, imageId, sessionMs: 10_000, maxOutputBytes: 128 * 1024 });
  client = new IsolatedMcpStdioClient(channel, { callMs: 2000, initializeMs: 2000, sessionMs: 10_000, maxFrameBytes: 16 * 1024, closeMs: 10_000 });
  await client.initialize();
  assert.equal((await client.listTools()).tools[0]?.name, 'probe');
  const result = await client.callTool({ name: 'probe' });
  assert.deepEqual(result.structuredContent, { uid: 65532, rootDenied: true, networkDenied: true });
  await client.close();
  assert.equal(await docker(['ps', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`]), '');
  console.log(JSON.stringify({ status: 'passed', imageId, checks: ['unattested-container-not-started', 'real-stdio-initialize', 'list-call', 'unprivileged-uid',
    'root-write-denied', 'network-probe-denied', 'container-removed'], scope: 'Source-code OCI channel; not installed package or admission integration' }, null, 2));
} finally {
  await client?.close().catch(() => {});
  await runPortableProcess(['docker', 'rm', '--force', id], { timeoutMs: 10_000, maxOutputCharacters: 1024 });
}
