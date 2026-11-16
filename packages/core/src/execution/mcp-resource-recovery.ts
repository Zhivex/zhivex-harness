import type { AgentRunStore, AgentStoreScope, AgentToolCallJournalEntry } from '@zhivex-ai/core';
import { mcpResourcePlanSchema, mcpResourceOutputSchema, mcpResourceLabels, matchesMcpResourceScope, type McpResourcePlan } from '../persistence/mcp-resource-journal.js';
import { runPortableProcess } from './process-runtime.js';

type DockerCli = (args: string[]) => Promise<string>;
function ownerIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function labelsMatch(actual: unknown, plan: McpResourcePlan): boolean {
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(mcpResourceLabels(plan)).every(([key, value]) => (actual as Record<string, unknown>)[key] === value);
}

/** Internal recovery primitive. CLI must target the host-selected Docker daemon. */
export async function recoverMcpResources(options: {
  store: AgentRunStore; runId: string; scope: AgentStoreScope; hostId: string; cli: DockerCli;
}): Promise<{ closed: number; deferred: number }> {
  const { store, cli, runId, hostId } = options;
  const scope = structuredClone(options.scope);
  if (!store.listToolCalls || !store.saveToolCall || !hostId) throw new Error('MCP recovery requires a durable host scope.');
  const daemon = await cli(['info', '--format', '{{.ID}}']);
  const rows = await store.listToolCalls(runId, scope);
  let closed = 0, deferred = 0;
  for (const row of rows.filter(entry => entry.toolName === 'isolated_mcp_resources')) {
    const plan = mcpResourcePlanSchema.parse(row.input);
    if (mcpResourceOutputSchema.parse(row.output).phase === 'closed') continue;
    if (row.toolCallId !== `mcp_resources_${plan.leaseId}` || !matchesMcpResourceScope(plan, runId, scope, hostId) || plan.daemonId !== daemon || !ownerIsDead(plan.ownerPid)) {
      deferred++; continue;
    }
    let current = row;
    const record = async (phase: 'closing' | 'closed' | 'cleanup_required') => {
      const { error: _oldError, ...base } = current;
      const entry: AgentToolCallJournalEntry = { ...base, output: { schemaVersion: 1, phase }, updatedAt: Date.now(),
        status: phase === 'closed' ? 'completed' : phase === 'cleanup_required' ? 'failed' : 'running',
        ...(phase === 'closed' ? { completedAt: Date.now() } : {}),
        ...(phase === 'cleanup_required' ? { error: { message: 'MCP_RESOURCE_CLEANUP_REQUIRED' } } : {}) };
      current = await store.saveToolCall!(entry, { expectedRevision: current.revision });
    };
    const inspectContainer = async (name: string, image: string) => {
      const ids = await cli(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`]);
      if (!ids) return undefined;
      if (!/^[a-f0-9]{64}$/.test(ids)) throw new Error('MCP recovery container identity mismatch.');
      const values = JSON.parse(await cli(['inspect', ids]));
      const value = values[0];
      if (values.length !== 1 || value?.Id !== ids || value?.Name !== `/${name}` || value?.Image !== image || !labelsMatch(value?.Config?.Labels, plan)) {
        throw new Error('MCP recovery container ownership mismatch.');
      }
      return ids;
    };
    const inspectVolume = async () => {
      const names = (await cli(['volume', 'ls', '--quiet', '--filter', `name=${plan.volumeName}`])).split('\n');
      if (!names.includes(plan.volumeName)) return false;
      const values = JSON.parse(await cli(['volume', 'inspect', plan.volumeName]));
      if (values.length !== 1 || values[0]?.Name !== plan.volumeName || !labelsMatch(values[0]?.Labels, plan)) throw new Error('MCP recovery volume ownership mismatch.');
      return true;
    };
    // Reserve the journal revision before any Docker mutation. Failed claims do
    // not authorize cleanup, even if a different recovering host has progressed.
    await record('closing');
    try {
      const server = await inspectContainer(plan.serverName, plan.serverImageId);
      const seeder = await inspectContainer(plan.seederName, plan.provisionerImageId);
      const volume = await inspectVolume();
      if (await cli(['info', '--format', '{{.ID}}']) !== daemon || !ownerIsDead(plan.ownerPid)) throw new Error('MCP recovery owner changed.');
      for (const id of [server, seeder]) if (id) await cli(['rm', '--force', id]);
      if (volume) {
        await inspectVolume();
        await cli(['volume', 'rm', plan.volumeName]);
      }
      if (await inspectContainer(plan.serverName, plan.serverImageId) || await inspectContainer(plan.seederName, plan.provisionerImageId) || await inspectVolume()) {
        throw new Error('MCP recovery absence not confirmed.');
      }
      await record('closed'); closed++;
    } catch {
      await record('cleanup_required');
      throw new Error('MCP resource recovery could not confirm cleanup.');
    }
  }
  return { closed, deferred };
}

/** Host-only entry point; never discovers or sweeps resources outside persisted names. */
export async function recoverDockerMcpResources(options: Omit<Parameters<typeof recoverMcpResources>[0], 'cli'>) {
  const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']
    .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  return recoverMcpResources({ ...options, cli: async args => {
    const result = await runPortableProcess(['docker', ...args], { env, timeoutMs: 10_000, maxOutputCharacters: 1024 * 1024 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('MCP recovery Docker operation failed.');
    return result.stdout.trim();
  } });
}
