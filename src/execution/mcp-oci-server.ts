import { issueMcpHostSession, closeMcpHostSession, combineMcpHostSessions } from '../integrations/mcp-host-session.js';
import { reserveMcpResources, type McpResourceLeaseJournal } from '../persistence/mcp-resource-journal.js';
import { recoverDockerMcpResources } from './mcp-resource-recovery.js';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPortableProcess } from './process-runtime.js';
import { openDockerMcpChannel, removeDockerMcpBoundary } from './mcp-oci-channel.js';
import { createDockerMcpWorkspace, type DockerMcpWorkspaceLease } from './mcp-oci-workspace.js';
import { withAdmittedMcpLaunch } from '../integrations/mcp-stdio-launch.js';
import { IsolatedMcpStdioClient, type IsolatedMcpChannel } from '../integrations/mcp-stdio-client.js';
import type { McpStdioLaunchProposal } from '../integrations/mcp-stdio-admission.js';
import { createIsolatedMcpTools } from '../integrations/mcp-stdio-tools.js';
import { discardMcpWorkspaceSnapshot } from './mcp-workspace-snapshot.js';

const endpointKeys = ['HOME', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR'];
async function dockerExecutable() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, 'docker');
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Next executable search directory. */ }
  }
  throw new Error('Docker is unavailable.');
}
export function effectiveMcpContainerEnvironment(input: unknown): Record<string, string> {
  if (!Array.isArray(input)) throw new Error('Invalid MCP container environment.');
  const result: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== 'string') throw new Error('Invalid MCP container environment.');
    const index = entry.indexOf('=');
    const name = index < 0 ? entry : entry.slice(0, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) throw new Error('Invalid MCP container environment.');
    seen.add(name);
    if (index >= 0) result[name] = entry.slice(index + 1);
  }
  return result;
}
const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);

/** Complete pre-start checks in addition to openDockerMcpChannel's isolation checks. */
export function attestMcpServer(inspection: unknown, expected: {
  imageId: string; volumeName: string; proposal: Readonly<McpStdioLaunchProposal>; environment: Readonly<Record<string, string>>;
}): void {
  const value = inspection as Record<string, any>;
  const proposal = expected.proposal, limits = proposal.limits;
  const config = value?.Config, host = value?.HostConfig;
  const environment = effectiveMcpContainerEnvironment(config?.Env);
  const wanted = expected.environment;
  const mounts = value?.Mounts;
  const tmpfs = `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsMb}m,uid=65532,gid=65532,mode=0700`;
  const checks: Record<string, boolean> = {
    identity: value?.Image === expected.imageId && value?.State?.Status === 'created',
    command: same(config?.Entrypoint, [proposal.executable]) && same(config?.Cmd ?? [], proposal.args),
    user: config?.User === '65532:65532' && config?.Hostname === 'mcp',
    cwd: config?.WorkingDir === (proposal.workingDirectory === '.' ? '/workspace' : `/workspace/${proposal.workingDirectory}`),
    auxiliary: config?.Healthcheck?.Test?.[0] === 'NONE' && host?.RestartPolicy?.Name === 'no' && host?.LogConfig?.Type === 'none' && host?.IpcMode === 'none',
    memory: host?.Memory === limits.memoryMb * 1024 * 1024 && host?.MemorySwap === limits.memoryMb * 1024 * 1024,
    processes: host?.PidsLimit === limits.maxPids && host?.NanoCpus === Math.round(limits.maxCpus * 1e9),
    tmpfs: same(host?.Tmpfs, { '/tmp': tmpfs.slice(5) }),
    writes: same(host?.Ulimits, [{ Name: 'fsize', Hard: limits.maxFileWriteBytes, Soft: limits.maxFileWriteBytes }]),
    environment: Object.keys(environment).length === Object.keys(wanted).length && Object.keys(wanted).every(key => environment[key] === wanted[key]),
    mount: Array.isArray(mounts) && mounts.length === 1 && mounts[0]?.Type === 'volume' && mounts[0]?.Name === expected.volumeName &&
      mounts[0]?.Destination === '/workspace' && mounts[0]?.RW === proposal.permissions.includes('write')
  };
  const failed = Object.keys(checks).filter(key => !checks[key]);
  if (failed.length) throw new McpServerAttestationError(failed);
}
class McpServerAttestationError extends Error {
  constructor(readonly fields: string[]) { super('MCP server does not match its admission.'); }
}

/** Internal host API. Per-tool approvals and durable lifecycle integration remain above this layer. */
export async function launchDockerMcpServer(options: Omit<Parameters<typeof withAdmittedMcpLaunch>[0], 'seed'> & {
  provisionerImageId: string;
  resourceJournal?: Pick<Parameters<typeof reserveMcpResources>[0], 'store' | 'runId' | 'scope' | 'hostId'>;
}): Promise<IsolatedMcpStdioClient> {
  let workspace: DockerMcpWorkspaceLease | undefined;
  let channel: IsolatedMcpChannel | undefined;
  let client: IsolatedMcpStdioClient | undefined;
  let container: string | undefined;
  let attempted = false;
  let resources: McpResourceLeaseJournal | undefined;
  let containerName = `zhx-mcp-server-${randomUUID()}`;
  let cli: ((args: string[], env?: Record<string, string | undefined>) => Promise<string>) | undefined;
  let privateRoot: string | undefined;
  let phase = 'admission';
  const confirmResourceAbsence = async () => {
    if (!resources || !cli) return;
    for (const name of [resources.plan.serverName, resources.plan.seederName]) {
      if (await cli(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`])) throw new Error('MCP resource remains.');
    }
    if ((await cli(['volume', 'ls', '--quiet', '--filter', `name=${resources.plan.volumeName}`])).split('\n').includes(resources.plan.volumeName)) {
      throw new Error('MCP resource remains.');
    }
  };
  try {
    return await withAdmittedMcpLaunch({ ...options, seed: async ({ proposal, environment, files }) => {
      phase = 'image-inspection';
      const executable = await dockerExecutable();
      const endpoint = Object.fromEntries(endpointKeys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      cli = async (args, additions) => {
        const result = await runPortableProcess([executable, ...args], { env: { ...endpoint, ...additions }, timeoutMs: 10_000, maxOutputCharacters: 1024 * 1024 });
        if (result.exitCode !== 0 || result.timedOut) throw new Error('MCP server Docker operation failed.');
        return result.stdout.trim();
      };
      const image = JSON.parse(await cli(['image', 'inspect', proposal.image]))[0];
      if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '') || Object.keys(image?.Config?.Volumes ?? {}).length > 0) throw new Error('Invalid MCP server image.');
      const inherited = effectiveMcpContainerEnvironment(image?.Config?.Env ?? []);
      const removed = Object.keys(inherited).filter(key => !(key in environment));
      if (removed.some(key => endpointKeys.includes(key))) throw new Error('MCP image environment conflicts with Docker control.');
      // Bare --env names unset image defaults. Clear the corresponding CLI
      // environment too, so Docker cannot substitute host values for those names.
      const createEnvironment = Object.fromEntries(removed.map(key => [key, undefined]));
      privateRoot = await mkdtemp(path.join(tmpdir(), 'zhx-mcp-env-'));
      const envFile = path.join(privateRoot, 'environment');
      await writeFile(envFile, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      if (options.resourceJournal) {
        phase = 'resource-reservation';
        resources = await reserveMcpResources({ ...options.resourceJournal, proposal, serverImageId: image.Id,
          provisionerImageId: options.provisionerImageId, daemonId: await cli(['info', '--format', '{{.ID}}']) });
        containerName = resources.plan.serverName;
        await resources.advance('provisioning');
      }
      phase = 'workspace';
      workspace = await createDockerMcpWorkspace({ provisionerImageId: options.provisionerImageId, proposal, files, ...(resources ? { resources } : {}) });
      const limits = proposal.limits;
      attempted = true;
      phase = 'container-create';
      container = await cli(['create', '--name', containerName, '--hostname', 'mcp', '--pull', 'never', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', '65532:65532', '--ipc', 'none', '--no-healthcheck', '--restart', 'no', '--log-driver', 'none',
        '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--pids-limit', String(limits.maxPids), '--cpus', String(limits.maxCpus),
        '--ulimit', `fsize=${limits.maxFileWriteBytes}:${limits.maxFileWriteBytes}`,
        '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsMb}m,uid=65532,gid=65532,mode=0700`,
        ...Object.entries(resources?.labels ?? { 'com.zhivex.harness.mcp': 'v1', 'com.zhivex.harness.owner-pid': String(process.pid) }).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        '--mount', `type=volume,src=${workspace.volumeName},dst=/workspace,volume-nocopy${proposal.permissions.includes('write') ? '' : ',readonly'}`,
        ...removed.flatMap(key => ['--env', key]), '--env-file', envFile, '--workdir', proposal.workingDirectory === '.' ? '/workspace' : `/workspace/${proposal.workingDirectory}`,
        '--entrypoint', proposal.executable, image.Id, ...proposal.args], createEnvironment);
      if (!/^[a-f0-9]{64}$/.test(container)) { container = undefined; throw new Error('Invalid MCP container identity.'); }
      await rm(privateRoot, { recursive: true, force: true }); privateRoot = undefined;
      phase = 'attestation';
      channel = await openDockerMcpChannel({ containerId: container, imageId: image.Id, sessionMs: limits.sessionMs, maxOutputBytes: limits.maxOutputBytes,
        attest: inspection => {
          try { attestMcpServer(inspection, { imageId: image.Id, volumeName: workspace!.volumeName, proposal, environment }); }
          catch (error) { if (error instanceof McpServerAttestationError) phase = `attestation:${error.fields.join(',')}`; throw error; }
        } });
      const serverChannel = channel, ownedWorkspace = workspace;
      const managed: IsolatedMcpChannel = { stdout: channel.stdout, write: frame => serverChannel.write(frame),
        async close() {
          let journalFailed = false, cleanupFailed = false;
          try { await resources?.advance('closing'); } catch { journalFailed = true; }
          try { await serverChannel.close(); } catch { cleanupFailed = true; }
          try { await ownedWorkspace.close(); } catch { cleanupFailed = true; }
          try { await confirmResourceAbsence(); } catch { cleanupFailed = true; }
          try { await resources?.advance(cleanupFailed ? 'cleanup_required' : 'closed'); } catch { journalFailed = true; }
          if (cleanupFailed || journalFailed) throw new Error('MCP resource cleanup or its durable record was not confirmed.');
        } };
      client = new IsolatedMcpStdioClient(managed, { callMs: limits.callMs, initializeMs: Math.min(10_000, limits.sessionMs), sessionMs: limits.sessionMs,
        maxFrameBytes: Math.min(1024 * 1024, limits.maxOutputBytes), closeMs: 60_000 });
      phase = 'initialization';
      await client.initialize();
      phase = 'seeder-stop';
      await workspace.stopSeeder();
      await resources?.advance('ready');
      return client;
    } });
  } catch {
    let cleanupFailed = false;
    // A failed durable write must never prevent best-effort resource cleanup.
    if (!client) { try { await resources?.advance('closing'); } catch { cleanupFailed = true; } }
    try {
      if (client) await client.close();
      else if (channel) await channel.close();
      else if (container && cli) await removeDockerMcpBoundary(cli, container);
      else if (attempted && cli) {
        await cli(['rm', '--force', containerName]).catch(() => {});
        if (await cli(['ps', '--all', '--quiet', '--filter', `name=^/${containerName}$`])) throw new Error('cleanup');
      }
    } catch { cleanupFailed = true; }
    try { await workspace?.close(); } catch { cleanupFailed = true; }
    try { await confirmResourceAbsence(); } catch { cleanupFailed = true; }
    if (!client) { try { await resources?.advance(cleanupFailed ? 'cleanup_required' : 'closed'); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new Error('MCP server cleanup was not confirmed.');
    throw new Error(`MCP admitted server launch failed (${phase}).`);
  } finally { if (privateRoot) await rm(privateRoot, { recursive: true, force: true }); }
}

/** Agent-facing internal bridge; does not expose the unguarded transport client. */
type McpToolLaunchOptions = Parameters<typeof launchDockerMcpServer>[0] & {
  journal: NonNullable<Parameters<typeof createIsolatedMcpTools>[0]['journal']> & { hostId: string };
};
export async function launchDockerMcpTools(options: McpToolLaunchOptions) {
  return launchMcpToolsOwned(options, false);
}
async function launchMcpToolsOwned(options: McpToolLaunchOptions, groupRecoveryComplete: boolean) {
  const journal = options.journal ? { ...options.journal, scope: structuredClone(options.journal.scope) } : undefined;
  if (!journal || !journal.hostId || !journal.store?.loadToolCall || !journal.store.saveToolCall || !journal.store?.claimToolExecution || !journal.store.completeToolExecution || !journal.store.listToolCalls ||
      journal.runId !== options.scope.session || journal.scope?.tenantId !== options.scope.tenant || journal.scope.userId !== options.scope.principal) {
    await discardMcpWorkspaceSnapshot(options.snapshot);
    throw new Error('MCP tool launch requires a matching durable journal.');
  }
  try {
    const recovery = groupRecoveryComplete ? { deferred: 0 } : await recoverDockerMcpResources(journal);
    if (recovery.deferred > 0) throw new Error('Unresolved MCP resources.');
  } catch {
    await discardMcpWorkspaceSnapshot(options.snapshot);
    throw new Error('MCP tool launch requires confirmed recovery of prior resources.');
  }
  const proposal = structuredClone(options.proposal) as McpStdioLaunchProposal;
  const sensitiveValues: string[] = Object.values(proposal.environment);
  const client = await launchDockerMcpServer({ ...options, resourceJournal: journal, proposal, resolveSecret: async (reference, signal) => {
    const value = await options.resolveSecret(reference, signal);
    if (value !== undefined) sensitiveValues.push(value);
    return value;
  } });
  try {
    const tools = await createIsolatedMcpTools({ client, proposal, sensitiveValues, journal });
    const hostSession = issueMcpHostSession({ tools, ...journal, proposal, close: () => client.close() });
    return Object.freeze({ tools, hostSession, close: () => closeMcpHostSession(hostSession) });
  } catch {
    await client.close();
    throw new Error('MCP admitted tool setup failed.');
  }
}

/** One host-owned batch. Recovery is performed by the first launch; later members
 * belong to that batch and must not treat their live siblings as crashed owners. */
export async function launchDockerMcpGroup(input: readonly (McpToolLaunchOptions & { proposal: McpStdioLaunchProposal })[], signal?: AbortSignal) {
  const launched: Awaited<ReturnType<typeof launchDockerMcpTools>>[] = [];
  try {
    if (!input.length || input.length > 8) throw new Error('Invalid MCP group size.');
    const first = input[0]!;
    const prefixes = new Set<string>();
    for (const item of input) {
      if (!item.journal || !first.journal || item.journal.store !== first.journal.store || item.journal.hostId !== first.journal.hostId ||
          item.journal.runId !== first.journal.runId || item.journal.scope.tenantId !== first.journal.scope.tenantId ||
          item.journal.scope.userId !== first.journal.scope.userId || item.journal.scope.namespace !== first.journal.scope.namespace ||
          item.scope.workspace !== first.scope.workspace || item.proposal.snapshotDigest !== first.proposal.snapshotDigest) throw new Error('MCP group identity mismatch.');
      const prefix = item.proposal.serverId.replace(/-/g, '_');
      if (prefixes.has(prefix)) throw new Error('MCP group namespace collision.');
      prefixes.add(prefix);
    }
    for (const item of input) {
      if (signal?.aborted) throw new Error('MCP group launch cancelled.');
      launched.push(await launchMcpToolsOwned(item, launched.length > 0));
    }
    if (signal?.aborted) throw new Error('MCP group launch cancelled.');
    const hostSession = combineMcpHostSessions(launched.map(session => session.hostSession));
    return Object.freeze({ hostSession, close: () => closeMcpHostSession(hostSession) });
  } catch {
    const cleanup = await Promise.allSettled([
      ...launched.map(session => session.close()), ...input.map(item => discardMcpWorkspaceSnapshot(item.snapshot))
    ]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('MCP group cleanup was not confirmed.');
    throw new Error('MCP group admission or launch failed.');
  }
}
