import { createHash } from 'node:crypto';
import type { AgentRunStore, AgentStoreScope, AgentToolCallJournalEntry, JsonValue, McpClient } from '@zhivex-ai/core';
import type { McpStdioLaunchProposal } from '../integrations/mcp-stdio-admission.js';
import { McpStdioClientError } from '../integrations/mcp-stdio-client.js';

export class McpExecutionJournalError extends Error {
  constructor(readonly code: 'persistence_failed' | 'identity_changed' | 'replay_denied' | 'outcome_unknown' | 'cleanup_required', readonly outcomeUnknown: boolean) {
    super(`MCP durable execution ${code}.`); this.name = 'McpExecutionJournalError';
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Reuses the scoped operations journal. Never stores raw arguments, secrets or server output. */
export function createJournaledMcpClient(options: {
  client: McpClient & { close(): Promise<void> };
  proposal: Readonly<McpStdioLaunchProposal>;
  store: AgentRunStore;
  runId: string;
  scope: AgentStoreScope;
}): McpClient & { close(): Promise<void> } {
  if (!options.store.claimToolExecution || !options.store.completeToolExecution || !options.store.listToolCalls ||
      options.runId !== options.proposal.scope.session || options.scope.tenantId !== options.proposal.scope.tenant ||
      options.scope.userId !== options.proposal.scope.principal) throw new McpExecutionJournalError('identity_changed', false);
  const scope = structuredClone(options.scope);
  const runId = options.runId;
  const proposalHash = hash(options.proposal);
  const serverId = options.proposal.serverId;
  const claim = options.store.claimToolExecution.bind(options.store);
  const complete = options.store.completeToolExecution.bind(options.store);
  const list = options.store.listToolCalls.bind(options.store);
  let stopped = false;
  const stop = async (code: McpExecutionJournalError['code'], uncertain: boolean): Promise<never> => {
    stopped = true;
    try { await options.client.close(); }
    catch { throw new McpExecutionJournalError('cleanup_required', uncertain); }
    throw new McpExecutionJournalError(code, uncertain);
  };
  return {
    listTools: (input, callOptions) => options.client.listTools(input, callOptions),
    close: () => options.client.close(),
    async callTool(input, callOptions) {
      if (stopped) throw new McpExecutionJournalError('outcome_unknown', true);
      const idempotencyKey = callOptions?.idempotencyKey;
      if (!idempotencyKey || idempotencyKey.length > 1024) throw new McpExecutionJournalError('identity_changed', false);
      if (callOptions?.abortSignal?.aborted) throw new McpStdioClientError('cancelled', 'MCP call cancelled before durable dispatch.');
      let prior: AgentToolCallJournalEntry[];
      try { prior = await list(runId, scope); } catch { throw new McpExecutionJournalError('persistence_failed', false); }
      if (prior.some(entry => entry.toolName === 'isolated_mcp_call' &&
          (entry.status === 'pending' || entry.status === 'running' || entry.error?.message === 'MCP_OUTCOME_UNKNOWN'))) {
        return stop('outcome_unknown', true);
      }
      const toolCallId = `mcp_execution_${hash({ serverId, idempotencyKey })}`;
      const identity = { schemaVersion: 1, kind: 'isolated-mcp-call', proposalHash, argumentsHash: hash(input), toolNameHash: hash(input.name) };
      let claimed: Awaited<ReturnType<typeof claim>>;
      try {
        claimed = await claim({ runId, scope, toolCallId, toolName: 'isolated_mcp_call', status: 'pending',
          idempotencyKey: `${runId}:${toolCallId}`, revision: 0, input: identity, updatedAt: Date.now() });
      } catch { throw new McpExecutionJournalError('persistence_failed', false); }
      if (!claimed.claimed) {
        if (canonical(claimed.entry.input) !== canonical(identity)) throw new McpExecutionJournalError('identity_changed', false);
        const uncertain = claimed.entry.status === 'pending' || claimed.entry.status === 'running' ||
          claimed.entry.error?.message === 'MCP_OUTCOME_UNKNOWN';
        if (uncertain) return stop('outcome_unknown', true);
        throw new McpExecutionJournalError('replay_denied', false);
      }
      const entry: AgentToolCallJournalEntry = claimed.entry;
      let output;
      try { output = await options.client.callTool(input, callOptions); }
      catch (error) {
        const uncertain = !(error instanceof McpStdioClientError) || error.outcomeUnknown;
        try {
          await complete({ ...entry, status: 'failed', error: { message: uncertain ? 'MCP_OUTCOME_UNKNOWN' : 'MCP_NOT_DISPATCHED' },
            completedAt: Date.now(), updatedAt: Date.now() }, { expectedRevision: entry.revision });
        } catch { return stop('persistence_failed', uncertain); }
        if (uncertain) return stop('outcome_unknown', true);
        throw new McpStdioClientError('closed', 'MCP durable call failed before dispatch.');
      }
      // A failed completion write leaves the claim unresolved and therefore
      // unreplayable. Never turn a lost acknowledgement into another execution.
      try {
        await complete({ ...entry, status: 'completed', output: { outcome: 'completed', outputHash: hash(output) } as JsonValue,
          completedAt: Date.now(), updatedAt: Date.now() }, { expectedRevision: entry.revision });
      } catch { return stop('persistence_failed', true); }
      return output;
    }
  };
}
