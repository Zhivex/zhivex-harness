import { createHash } from 'node:crypto';
import type { AgentRunStore, AgentStoreScope, ToolSet } from '@zhivex-ai/core';
import type { McpStdioLaunchProposal } from './mcp-stdio-admission.js';

/** Opaque capability issued only after the host's admitted OCI launch succeeds. */
export type HarnessIsolatedMcpSession = Readonly<Record<never, never>>;
const sessions = new WeakMap<object, {
  tools: ToolSet; store: AgentRunStore; scope: AgentStoreScope; runId: string;
  workspace: string; fingerprint: string; close(): Promise<void>; active: boolean;
}>();

/** Internal issuer; this module is not a package entry point. */
export function issueMcpHostSession(options: {
  tools: ToolSet; store: AgentRunStore; scope: AgentStoreScope; runId: string;
  proposal: Readonly<McpStdioLaunchProposal>; close(): Promise<void>;
}): HarnessIsolatedMcpSession {
  const token = Object.freeze({});
  const tools = Object.freeze(Object.fromEntries(Object.entries(options.tools).map(([name, tool]) => [name, Object.freeze({ ...tool })]))) as ToolSet;
  const session = { tools, store: options.store, scope: structuredClone(options.scope), runId: options.runId,
    workspace: options.proposal.scope.workspace,
    fingerprint: createHash('sha256').update(JSON.stringify(options.proposal)).digest('hex'), active: true,
    async close() { session.active = false; await options.close(); }
  };
  sessions.set(token, session);
  return token;
}

export function resolveMcpHostSession(token: HarnessIsolatedMcpSession) {
  const session = sessions.get(token);
  if (!session || !session.active) throw new Error('An active host-admitted MCP session is required.');
  return session;
}

export async function closeMcpHostSession(token: HarnessIsolatedMcpSession) {
  const session = sessions.get(token);
  if (session) await session.close();
}

/** Internal composition of already admitted sessions; never accepts raw tools. */
export function combineMcpHostSessions(tokens: readonly HarnessIsolatedMcpSession[]): HarnessIsolatedMcpSession {
  if (!tokens.length || tokens.length > 8 || new Set(tokens).size !== tokens.length) throw new Error('Invalid MCP session group.');
  const children = tokens.map(resolveMcpHostSession), first = children[0]!;
  const tools: ToolSet = {};
  for (const child of children) {
    if (child.store !== first.store || child.runId !== first.runId || child.workspace !== first.workspace ||
        child.scope.tenantId !== first.scope.tenantId || child.scope.userId !== first.scope.userId || child.scope.namespace !== first.scope.namespace) {
      throw new Error('MCP session group scope mismatch.');
    }
    for (const [name, definition] of Object.entries(child.tools)) {
      if (Object.hasOwn(tools, name)) throw new Error('MCP session group tool collision.');
      tools[name] = definition;
    }
  }
  const token = Object.freeze({});
  let closing: Promise<void> | undefined;
  const session = { ...first, tools: Object.freeze(tools) as ToolSet, active: true,
    fingerprint: createHash('sha256').update(JSON.stringify(children.map(child => child.fingerprint).sort())).digest('hex'),
    close() {
      session.active = false;
      return closing ??= (async () => {
        const results = await Promise.allSettled(children.map(child => child.close()));
        if (results.some(result => result.status === 'rejected')) throw new Error('MCP session group cleanup was not confirmed.');
      })();
    }
  };
  sessions.set(token, session); return token;
}
