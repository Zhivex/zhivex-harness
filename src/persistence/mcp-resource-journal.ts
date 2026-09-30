import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentRunStore, AgentStoreScope, AgentToolCallJournalEntry } from '@zhivex-ai/core';
import type { McpStdioLaunchProposal } from '../integrations/mcp-stdio-admission.js';

const ownerInstance = randomUUID();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const phases = ['reserved', 'provisioning', 'ready', 'closing', 'closed', 'cleanup_required'] as const;
export type McpResourcePhase = typeof phases[number];
export const mcpResourcePlanSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('isolated-mcp-resources'), leaseId: uuid,
  scopeHash: digest, hostHash: digest, proposalHash: digest,
  daemonId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  ownerPid: z.number().int().positive(), ownerInstance: uuid,
  serverImageId: image, provisionerImageId: image,
  serverName: z.string(), volumeName: z.string(), seederName: z.string()
}).strict().refine(value => value.serverName === `zhx-mcp-server-${value.leaseId}` &&
  value.volumeName === `zhx-mcp-${value.leaseId}` && value.seederName === `zhx-mcp-${value.leaseId}-seed`);
export type McpResourcePlan = Readonly<z.infer<typeof mcpResourcePlanSchema>>;
export const mcpResourceOutputSchema = z.object({ schemaVersion: z.literal(1), phase: z.enum(phases) }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const transitions: Record<McpResourcePhase, readonly McpResourcePhase[]> = {
  reserved: ['provisioning', 'closing', 'cleanup_required'], provisioning: ['ready', 'closing', 'cleanup_required'],
  ready: ['closing', 'cleanup_required'], closing: ['closed', 'cleanup_required'], cleanup_required: ['closing'], closed: []
};
export interface McpResourceLeaseJournal {
  readonly plan: McpResourcePlan;
  /** Label values contain only scoped identifiers, never commands or credentials. */
  readonly labels: Readonly<Record<string, string>>;
  advance(phase: McpResourcePhase): Promise<void>;
}

/** Reserve all names durably before creating any Docker resource. Host identity is host-owned. */
export async function reserveMcpResources(options: {
  store: AgentRunStore; runId: string; scope: AgentStoreScope; hostId: string; daemonId: string;
  proposal: Readonly<McpStdioLaunchProposal>; serverImageId: string; provisionerImageId: string;
}): Promise<McpResourceLeaseJournal> {
  if (!options.store.claimToolExecution || !options.store.loadToolCall || !options.store.saveToolCall ||
      !options.hostId || options.hostId.length > 256 || options.runId !== options.proposal.scope.session ||
      options.scope.tenantId !== options.proposal.scope.tenant || options.scope.userId !== options.proposal.scope.principal) {
    throw new Error('MCP resource journal binding is invalid.');
  }
  const scope = structuredClone(options.scope), runId = options.runId;
  const leaseId = randomUUID();
  const plan = Object.freeze(mcpResourcePlanSchema.parse({ schemaVersion: 1, kind: 'isolated-mcp-resources', leaseId,
    scopeHash: hash({ runId, scope }), hostHash: hash(options.hostId), proposalHash: hash(options.proposal),
    daemonId: options.daemonId, ownerPid: process.pid, ownerInstance, serverImageId: options.serverImageId,
    provisionerImageId: options.provisionerImageId, serverName: `zhx-mcp-server-${leaseId}`,
    volumeName: `zhx-mcp-${leaseId}`, seederName: `zhx-mcp-${leaseId}-seed` }));
  const id = `mcp_resources_${leaseId}`;
  const claim = await options.store.claimToolExecution({ runId, scope, toolCallId: id, toolName: 'isolated_mcp_resources',
    idempotencyKey: `${runId}:${id}`, status: 'pending', revision: 0, input: plan,
    output: { schemaVersion: 1, phase: 'reserved' }, updatedAt: Date.now() });
  if (!claim.claimed) throw new Error('MCP resource reservation already exists.');
  const load = options.store.loadToolCall.bind(options.store), save = options.store.saveToolCall.bind(options.store);
  let queue = Promise.resolve();
  const advance = async (next: McpResourcePhase) => {
    const current = await load(runId, id, scope);
    if (!current || current.toolName !== 'isolated_mcp_resources' || JSON.stringify(mcpResourcePlanSchema.parse(current.input)) !== JSON.stringify(plan)) {
      throw new Error('MCP resource journal identity changed.');
    }
    const phase = mcpResourceOutputSchema.parse(current.output).phase;
    if (phase === next) return;
    if (!transitions[phase].includes(next)) throw new Error('Invalid MCP resource lifecycle transition.');
    const { error: _previousError, ...base } = current;
    const entry: AgentToolCallJournalEntry = { ...base, status: next === 'closed' ? 'completed' : next === 'cleanup_required' ? 'failed' : 'running',
      output: { schemaVersion: 1, phase: next }, updatedAt: Date.now(),
      ...(next === 'closed' ? { completedAt: Date.now() } : {}),
      ...(next === 'cleanup_required' ? { error: { message: 'MCP_RESOURCE_CLEANUP_REQUIRED' } } : {}) };
    await save(entry, { expectedRevision: current.revision });
  };
  return Object.freeze({ plan, labels: Object.freeze({
    'com.zhivex.harness.mcp': 'v1', 'com.zhivex.harness.owner-pid': String(plan.ownerPid),
    'com.zhivex.harness.mcp-lease': leaseId, 'com.zhivex.harness.mcp-scope': plan.scopeHash,
    'com.zhivex.harness.mcp-host': plan.hostHash, 'com.zhivex.harness.mcp-owner': ownerInstance
  }),
    advance(phase: McpResourcePhase) {
      const result = queue.then(() => advance(phase));
      queue = result.catch(() => {}); return result;
    }
  });
}

/** Reconstruct only non-secret ownership labels from a validated durable plan. */
export function mcpResourceLabels(plan: McpResourcePlan): Readonly<Record<string, string>> {
  return Object.freeze({
    'com.zhivex.harness.mcp': 'v1', 'com.zhivex.harness.owner-pid': String(plan.ownerPid),
    'com.zhivex.harness.mcp-lease': plan.leaseId, 'com.zhivex.harness.mcp-scope': plan.scopeHash,
    'com.zhivex.harness.mcp-host': plan.hostHash, 'com.zhivex.harness.mcp-owner': plan.ownerInstance
  });
}
export function matchesMcpResourceScope(plan: McpResourcePlan, runId: string, scope: AgentStoreScope, hostId: string): boolean {
  return !!hostId && plan.hostHash === hash(hostId) && plan.scopeHash === hash({ runId, scope });
}
