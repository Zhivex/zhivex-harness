import type { McpResourceLeaseJournal } from '../persistence/mcp-resource-journal.js';
import { randomUUID } from 'node:crypto';
import { runPortableProcess } from './process-runtime.js';
import { openDockerMcpChannel, removeDockerMcpBoundary } from './mcp-oci-channel.js';
import { IsolatedMcpStdioClient } from '../integrations/mcp-stdio-client.js';
import type { McpStdioLaunchProposal } from '../integrations/mcp-stdio-admission.js';

// Runs only in a separately host-provisioned, immutable Node image. Files arrive
// over the isolated input pipe; no host paths or file contents enter Docker argv.
const SEEDER = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const maximum = Number(process.env.ZHIVEX_MCP_WORKSPACE_BYTES);
let bytes = 0, entries = 0, current, poisoned = false, serial = Promise.resolve();
const safe = p => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f\x7f]/.test(p) && p.split('/').every(x => x && x !== '.' && x !== '..');
async function receive(line) {
 if (poisoned) return;
 let request;
 try {
  if (Buffer.byteLength(line) > 128 * 1024) throw Error();
  request = JSON.parse(line);
  if (!('id' in request)) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'workspace-seeder', version: '1' } };
  else if (request.method === 'tools/call') {
   const { name, arguments: input } = request.params;
   if (name === 'begin') {
    if (current || !safe(input.path) || ++entries > 20000) throw Error();
    const target = path.join('/workspace', input.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    current = await fs.open(target, 'wx', input.writable ? (input.executable ? 0o700 : 0o600) : (input.executable ? 0o500 : 0o400));
   } else if (name === 'chunk') {
    if (!current || typeof input.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw Error();
    const data = Buffer.from(input.data, 'base64');
    if (data.length > 65536 || (bytes += data.length) > maximum) throw Error();
    let offset = 0;
    while (offset < data.length) {
     const written = await current.write(data, offset, data.length - offset);
     if (!written.bytesWritten) throw Error();
     offset += written.bytesWritten;
    }
   } else if (name === 'end') {
    if (!current) throw Error(); await current.close(); current = undefined;
   } else if (name === 'complete') {
    if (current || bytes !== input.bytes || entries !== input.entries) throw Error();
   } else throw Error();
   result = { content: [], structuredContent: { bytes, entries } };
  } else throw Error();
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
 } catch {
  poisoned = true;
  if (current) await current.close().catch(() => {});
  process.exitCode = 1; process.stdin.destroy();
 }
}
readline.createInterface({ input: process.stdin }).on('line', line => { serial = serial.then(() => receive(line)); });
`;

type File = { path: string; contents: Uint8Array; executable: boolean };
export interface DockerMcpWorkspaceLease {
  /** Private volume must be mounted only by the admitted server, read-only unless write was admitted. */
  readonly volumeName: string;
  /** Keep the seeder alive until the server mounts the tmpfs, otherwise its data disappears. */
  stopSeeder(): Promise<void>;
  /** The owner must first remove every server using this volume. */
  close(): Promise<void>;
}

/** Host-only creator, invoked inside withAdmittedMcpLaunch's seed callback. */
export async function createDockerMcpWorkspace(options: {
  provisionerImageId: string;
  resources?: McpResourceLeaseJournal;
  proposal: Readonly<McpStdioLaunchProposal>;
  files: AsyncIterable<File>;
}): Promise<DockerMcpWorkspaceLease> {
  if (!/^sha256:[a-f0-9]{64}$/.test(options.provisionerImageId)) throw new Error('MCP provisioner requires an immutable local image.');
  const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
    .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const cli = async (args: string[]) => {
    const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 10_000, maxOutputCharacters: 64 * 1024 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('MCP workspace Docker operation failed.');
    return result.stdout.trim();
  };
  const name = options.resources?.plan.volumeName ?? `zhx-mcp-${randomUUID()}`;
  const containerName = `${name}-seed`;
  const ownership = options.resources?.labels ?? { 'com.zhivex.harness.mcp': 'v1', 'com.zhivex.harness.owner-pid': String(process.pid) };
  const labels = Object.entries(ownership).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const limits = options.proposal.limits;
  const volumeOptions = `size=${limits.maxWorkspaceBytes},uid=65532,gid=65532,mode=0700,noexec,nosuid,nodev`;
  let container: string | undefined;
  let client: IsolatedMcpStdioClient | undefined;
  let volumeAttempted = false;
  let containerAttempted = false;
  let closing: Promise<void> | undefined;
  const stopSeeder = async () => {
    if (client) await client.close();
    else if (container) await removeDockerMcpBoundary(cli, container);
    else if (containerAttempted) {
      // Creation may succeed even if its CLI response is lost. Reconcile only
      // the unpredictable name reserved by this owner, never arbitrary resources.
      await cli(['rm', '--force', containerName]).catch(() => {});
      if (await cli(['ps', '--all', '--quiet', '--filter', `name=^/${containerName}$`])) throw new Error('MCP seeder cleanup was not confirmed.');
    }
  };
  const close = () => closing ??= (async () => {
    let failed = false;
    try { await stopSeeder(); } catch { failed = true; }
    if (volumeAttempted) {
      await cli(['volume', 'rm', '--force', name]).catch(() => {});
      try {
        const volumes = (await cli(['volume', 'ls', '--quiet', '--filter', `name=${name}`])).split('\n');
        if (volumes.includes(name)) failed = true;
      } catch { failed = true; }
    }
    if (failed) throw new Error('MCP workspace cleanup was not confirmed.');
  })();
  try {
    // Inspect first: no implicit image download or mutable tag resolution.
    const image = JSON.parse(await cli(['image', 'inspect', options.provisionerImageId]))[0];
    if (image?.Id !== options.provisionerImageId || Object.keys(image?.Config?.Volumes ?? {}).length > 0) throw new Error('Invalid MCP provisioner image.');
    volumeAttempted = true;
    await cli(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=${volumeOptions}`, ...labels, name]);
    const volume = JSON.parse(await cli(['volume', 'inspect', name]))[0];
    if (volume?.Name !== name || volume?.Driver !== 'local' || volume?.Options?.type !== 'tmpfs' || volume?.Options?.device !== 'tmpfs' ||
        volume?.Options?.o !== volumeOptions || !Object.entries(ownership).every(([key, value]) => volume?.Labels?.[key] === value)) throw new Error('MCP workspace volume was not attested.');
    containerAttempted = true;
    container = await cli(['create', '--name', containerName, '--pull', 'never', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`,
      '--pids-limit', String(limits.maxPids), '--cpus', String(limits.maxCpus), '--user', '65532:65532', ...labels,
      '--mount', `type=volume,src=${name},dst=/workspace,volume-nocopy`,
      '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=', '--env', 'LD_PRELOAD=', '--env', 'LD_LIBRARY_PATH=',
      '--env', `ZHIVEX_MCP_WORKSPACE_BYTES=${limits.maxWorkspaceBytes}`,
      '--entrypoint', '/usr/local/bin/node', options.provisionerImageId, '-e', SEEDER]);
    if (!/^[a-f0-9]{64}$/.test(container)) { container = undefined; throw new Error('Invalid MCP seeder identity.'); }
    const actual = JSON.parse(await cli(['inspect', container]))[0];
    const mounts = actual?.Mounts;
    if (actual?.HostConfig?.Memory !== limits.memoryMb * 1024 * 1024 || actual?.HostConfig?.MemorySwap !== limits.memoryMb * 1024 * 1024 ||
        actual?.HostConfig?.PidsLimit !== limits.maxPids || actual?.HostConfig?.NanoCpus !== Math.round(limits.maxCpus * 1e9) ||
        !Array.isArray(mounts) || mounts.length !== 1 || mounts[0]?.Name !== name || mounts[0]?.Destination !== '/workspace' || mounts[0]?.RW !== true) {
      throw new Error('MCP provisioner limits were not attested.');
    }
    const channel = await openDockerMcpChannel({ containerId: container, imageId: options.provisionerImageId,
      sessionMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 });
    client = new IsolatedMcpStdioClient(channel, { callMs: 5000, initializeMs: 5000, sessionMs: 60_000, maxFrameBytes: 128 * 1024, closeMs: 35_000 });
    await client.initialize();
    let bytes = 0, entries = 0;
    for await (const file of options.files) {
      if (++entries > 20_000 || (bytes += file.contents.byteLength) > limits.maxWorkspaceBytes) throw new Error('MCP seed exceeds admitted limits.');
      await client.callTool({ name: 'begin', arguments: { path: file.path, executable: file.executable, writable: options.proposal.permissions.includes('write') } });
      for (let offset = 0; offset < file.contents.byteLength; offset += 65536) {
        await client.callTool({ name: 'chunk', arguments: { data: Buffer.from(file.contents.subarray(offset, offset + 65536)).toString('base64') } });
      }
      await client.callTool({ name: 'end', arguments: {} });
    }
    await client.callTool({ name: 'complete', arguments: { bytes, entries } });
    return { volumeName: name, stopSeeder, close };
  } catch {
    await close();
    throw new Error('MCP workspace provisioning failed.');
  }
}
