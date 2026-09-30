import assert from 'node:assert/strict';
import { openDockerMcpChannel } from '../src/execution/mcp-oci-channel.js';
import { IsolatedMcpStdioClient, McpStdioClientError } from '../src/integrations/mcp-stdio-client.js';
import { runPortableProcess } from '../src/execution/process-runtime.js';

// Explicit local integration check: requires an already provisioned image, never pulls.
const image = process.env.HARNESS_MCP_SMOKE_IMAGE ?? 'node:22-alpine';
const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
  .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
async function docker(args: string[]) {
  const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 30_000, maxOutputCharacters: 64 * 1024 });
  assert.equal(result.exitCode, 0, `Docker hostile smoke operation failed: ${args[0]}`);
  assert.equal(result.timedOut, false); return result.stdout.trim();
}
const imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
const cases = ['startup-exit', 'initialize-hang', 'call-hang', 'cancel-descendants', 'invalid-utf8', 'invalid-json', 'oversized-frame', 'stderr-flood', 'session-deadline'] as const;
const results: { scenario: string; code: string; outcomeUnknown: boolean; removed: boolean }[] = [];
for (const scenario of cases) {
  const server = `
const mode = ${JSON.stringify(scenario)};
if (mode === 'startup-exit') process.exit(17);
setInterval(() => {}, 1000);
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (!('id' in m)) return;
 if (mode === 'initialize-hang') return;
 const send = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
 if (m.method === 'initialize') { send({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'hostile', version: '1' } }); return; }
 if (m.method === 'tools/list') { send({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }] }); return; }
 if (mode === 'cancel-descendants') {
   // PID 1 and its detached child deliberately ignore graceful termination.
   process.on('SIGTERM', () => {});
   const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('/tmp/child-started',String(process.pid));setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
   child.unref();
 }
 if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff, 0x0a]));
 if (mode === 'invalid-json') process.stdout.write('not-json\\n');
 if (mode === 'oversized-frame') process.stdout.write('x'.repeat(5000));
 if (mode === 'stderr-flood') process.stderr.write('redaction-canary'.repeat(10000));
});`;
  const id = await docker(['create', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '32', '--cpus', '0.5',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=1m,uid=65532,gid=65532',
    '--user', '65532:65532', '--label', 'com.zhivex.harness.mcp=v1',
    '--label', `com.zhivex.harness.owner-pid=${process.pid}`, '--entrypoint', 'node', imageId, '-e', server]);
  let client: IsolatedMcpStdioClient | undefined;
  try {
    const channel = await openDockerMcpChannel({ containerId: id, imageId, sessionMs: scenario === 'session-deadline' ? 2500 : 15_000, maxOutputBytes: 8192 });
    client = new IsolatedMcpStdioClient(channel, { callMs: scenario === 'call-hang' ? 300 : 6000,
      initializeMs: 2000, sessionMs: 15_000, maxFrameBytes: 4096, closeMs: 15_000 });
    let failure: unknown;
    try {
      await client.initialize();
      assert.equal((await client.listTools()).tools[0]?.name, 'probe');
      const controller = new AbortController();
      const calling = client.callTool({ name: 'probe' }, { abortSignal: controller.signal });
      // Observe the rejection immediately while checking that the descendant really exists.
      const settled = calling.then(() => undefined, error => error as unknown);
      if (scenario === 'cancel-descendants') {
        await docker(['exec', id, '/bin/sh', '-c', 'for i in 1 2 3 4 5; do test -s /tmp/child-started && exit 0; sleep 0.1; done; exit 1']);
        await docker(['exec', id, '/bin/sh', '-c', 'kill -0 "$(cat /tmp/child-started)"']);
        controller.abort();
      }
      failure = await settled;
    } catch (error) { if (!(error instanceof McpStdioClientError)) throw error; failure = error; }
    assert.ok(failure instanceof McpStdioClientError, 'hostile server must fail with a typed client error');
    assert.equal(failure.message.includes('redaction-canary'), false);
    assert.equal(failure.outcomeUnknown, scenario !== 'startup-exit' && scenario !== 'initialize-hang');
    if (scenario === 'cancel-descendants') assert.equal(failure.code, 'cancelled');
    if (scenario === 'call-hang' || scenario === 'initialize-hang') assert.equal(failure.code, 'timeout');
    await client.close();
    await client.close(); // Cleanup remains idempotent after failure.
    assert.equal(await docker(['ps', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`]), '');
    results.push({ scenario, code: failure.code, outcomeUnknown: failure.outcomeUnknown, removed: true });
    console.error(`Passed OCI lifecycle fixture: ${scenario}`);
  } finally {
    await client?.close().catch(() => {});
    await runPortableProcess(['docker', 'rm', '--force', id], { env, timeoutMs: 10_000, maxOutputCharacters: 1024 });
  }
}
console.log(JSON.stringify({ status: 'passed', imageId, results,
  scope: 'Real source OCI lifecycle fixtures; no installed-package, full admission or durable recovery claim' }, null, 2));
