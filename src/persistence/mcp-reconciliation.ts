import { z } from 'zod';
import type { AgentRunStore, AgentStoreScope } from '@zhivex-ai/core';
import { mcpResourcePlanSchema, mcpResourceOutputSchema, matchesMcpResourceScope } from './mcp-resource-journal.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('isolated-mcp-call'),
  proposalHash: digest, argumentsHash: digest, toolNameHash: digest }).strict();
const decisionSchema = z.object({
  toolCallId: z.string().regex(/^mcp_execution_[a-f0-9]{64}$/), expectedRevision: z.number().int().nonnegative(),
  outcome: z.enum(['effect_confirmed', 'no_effect_confirmed']), evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();
export type McpReconciliationDecision = z.infer<typeof decisionSchema>;
export interface McpReconciliationReview extends McpReconciliationDecision {
  readonly runId: string;
  readonly scope: Readonly<AgentStoreScope>;
  readonly proposalHash: string;
  readonly argumentsHash: string;
  readonly toolNameHash: string;
}

/** Host-only decision authority. No model tool or workspace configuration exposes it.
 * A resolution never supplies a fabricated result or replays the original key.
 * Fresh execution still requires fresh host admission and agent approval.
 */
export function createMcpReconciliationAuthority(options: {
  store: AgentRunStore; runId: string; scope: AgentStoreScope; hostId: string;
  authorize(review: Readonly<McpReconciliationReview>): Promise<boolean>;
}) {
  const { store, runId, hostId, authorize } = options;
  const scope = Object.freeze(structuredClone(options.scope));
  if (!store.loadToolCall || !store.saveToolCall || !store.listToolCalls || !runId || !hostId || !scope.userId || !scope.tenantId) {
    throw new Error('MCP reconciliation requires a scoped durable host authority.');
  }
  const load = store.loadToolCall.bind(store), save = store.saveToolCall.bind(store), list = store.listToolCalls.bind(store);
  const read = async (decision: McpReconciliationDecision) => {
    const row = await load(runId, decision.toolCallId, scope);
    if (!row || row.toolName !== 'isolated_mcp_call' || row.revision !== decision.expectedRevision ||
        !(row.status === 'pending' || row.status === 'running' || row.error?.message === 'MCP_OUTCOME_UNKNOWN')) {
      throw new Error('MCP reconciliation target is stale or has no unresolved outcome.');
    }
    const identity = identitySchema.parse(row.input);
    const resources = (await list(runId, scope)).filter(entry => entry.toolName === 'isolated_mcp_resources');
    if (!resources.length || resources.some(entry => {
      const plan = mcpResourcePlanSchema.parse(entry.input);
      return !matchesMcpResourceScope(plan, runId, scope, hostId) || mcpResourceOutputSchema.parse(entry.output).phase !== 'closed';
    })) throw new Error('MCP reconciliation requires confirmed resource cleanup.');
    return { row, identity };
  };
  return Object.freeze({
    async reconcile(input: McpReconciliationDecision): Promise<void> {
      const decision = Object.freeze(decisionSchema.parse(input));
      const initial = await read(decision);
      const review = Object.freeze({ ...decision, runId, scope, proposalHash: initial.identity.proposalHash,
        argumentsHash: initial.identity.argumentsHash, toolNameHash: initial.identity.toolNameHash });
      if (await authorize(review) !== true) throw new Error('MCP reconciliation was not authorized.');
      const current = await read(decision);
      if (JSON.stringify(current.identity) !== JSON.stringify(initial.identity)) throw new Error('MCP reconciliation identity changed.');
      const now = Date.now();
      await save({ ...current.row, status: 'failed', error: { message: 'MCP_OUTCOME_RECONCILED' }, completedAt: now, updatedAt: now,
        output: { schemaVersion: 1, kind: 'isolated-mcp-reconciliation', outcome: decision.outcome, evidenceDigest: decision.evidenceDigest,
          previousStatus: current.row.status, previousError: current.row.error?.message ?? null, reviewedRevision: decision.expectedRevision,
          actor: scope.userId!, resolvedAt: now }
      }, { expectedRevision: decision.expectedRevision });
    }
  });
}
