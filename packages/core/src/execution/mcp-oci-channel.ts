import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { runPortableProcess } from './process-runtime.js';
import type { IsolatedMcpChannel } from '../integrations/mcp-stdio-client.js';

/** Internal cleanup primitive; the owning channel supplies its fixed Docker endpoint. */
export async function removeDockerMcpBoundary(cli: (args: string[]) => Promise<string>, id: string): Promise<void> {
  // A failed graceful stop must not prevent forced removal. Only a final
  // successful absence check establishes cleanup, even if rm races an exit.
  await cli(['stop', '--time', '2', id]).catch(() => {});
  await cli(['rm', '--force', id]).catch(() => {});
  const remaining = (await cli(['ps', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`])).trim();
  if (remaining) throw new Error('Docker MCP boundary removal was not confirmed.');
}

/** Internal handle for a host-created OCI container, never a client-supplied command. */
export async function openDockerMcpChannel(options: {
  containerId: string; imageId: string; sessionMs: number; maxOutputBytes: number;
  attest?: (inspection: unknown) => void;
}): Promise<IsolatedMcpChannel> {
  if (!/^([a-f0-9]{64})$/.test(options.containerId) || !/^sha256:[a-f0-9]{64}$/.test(options.imageId)) throw new Error('Invalid isolated MCP container identity.');
  for (const value of [options.sessionMs, options.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid isolated MCP channel limit.');
  }
  // This helper only attaches to a stopped container that the host owns. The
  // admission coordinator must still bind its image, argv, secrets and snapshot.
  const id = options.containerId;
  // Inspection, cleanup and attachment must address the same Docker endpoint.
  const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
    .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const cli = async (args: string[]) => {
    const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 10_000, maxOutputCharacters: 64 * 1024 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('Docker MCP boundary operation failed.');
    return result.stdout;
  };
  const inspected = JSON.parse(await cli(['inspect', id]))[0];
  const config = inspected?.HostConfig;
  if (inspected?.Id !== id || inspected?.Image !== options.imageId || inspected?.State?.Running !== false ||
      inspected?.Config?.Labels?.['com.zhivex.harness.mcp'] !== 'v1' ||
      inspected?.Config?.Labels?.['com.zhivex.harness.owner-pid'] !== String(process.pid) ||
      inspected?.Config?.Tty !== false || inspected?.Config?.OpenStdin !== true ||
      config?.NetworkMode !== 'none' || config?.ReadonlyRootfs !== true ||
      !config?.CapDrop?.includes('ALL') || !config?.SecurityOpt?.includes('no-new-privileges') ||
      !(config?.Memory > 0) || !(config?.PidsLimit > 0) || !(config?.NanoCpus > 0) ||
      !/^[1-9][0-9]*:[1-9][0-9]*$/.test(inspected?.Config?.User ?? '') ||
      config?.Privileged || (config?.CapAdd?.length ?? 0) > 0 || (config?.Devices?.length ?? 0) > 0 ||
      (config?.DeviceRequests?.length ?? 0) > 0 || (config?.VolumesFrom?.length ?? 0) > 0 || config?.PidMode === 'host' || config?.IpcMode === 'host' ||
      (inspected?.Mounts ?? []).some((mount: { Type?: string }) => mount.Type === 'bind')) {
    throw new Error('Docker MCP boundary is not attested.');
  }
  options.attest?.(inspected);
  const child: ChildProcessWithoutNullStreams = spawn('docker', ['start', '--attach', '--interactive', id], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let closed: Promise<void> | undefined;
  let total = 0;
  let failure: Error | undefined;
  const exit = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  const close = () => closed ??= (async () => {
    clearTimeout(timer);
    child.stdin.destroy();
    try {
      await removeDockerMcpBoundary(cli, id);
    } finally {
      child.kill('SIGTERM');
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise<never>((_, reject) => { deadline = setTimeout(() => {
        child.kill('SIGKILL'); reject(new Error('Docker MCP attachment did not exit.'));
      }, 1000); })]); } finally { if (deadline) clearTimeout(deadline); }
    }
  })();
  const stop = (message: string) => { failure ??= new Error(message); void close().catch(() => {}); };
  const timer = setTimeout(() => stop('Docker MCP session deadline exceeded.'), options.sessionMs);
  child.stdin.on('error', () => stop('Docker MCP input failed.'));
  child.stderr.on('error', () => stop('Docker MCP diagnostic stream failed.'));
  child.on('error', () => stop('Docker MCP attachment failed.'));
  child.stderr.on('data', (chunk: Buffer) => {
    // Do not retain/log server diagnostics: secrets may occur even before handshake.
    total += chunk.byteLength;
    if (total > options.maxOutputBytes) stop('Docker MCP output limit exceeded.');
  });
  return {
    stdout: { async *[Symbol.asyncIterator]() {
      for await (const chunk of child.stdout) {
        total += (chunk as Buffer).byteLength;
        if (total > options.maxOutputBytes) { stop('Docker MCP output limit exceeded.'); break; }
        yield new Uint8Array(chunk as Buffer);
      }
      if (failure) throw failure;
    } },
    write(frame) {
      if (closed || failure || child.stdin.destroyed) return Promise.reject(new Error('Docker MCP channel is closed.'));
      return new Promise<void>((resolve, reject) => child.stdin.write(frame, error => error ? reject(new Error('Docker MCP write failed.')) : resolve()));
    },
    close
  };
}
