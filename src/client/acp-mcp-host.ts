import { createHash } from 'node:crypto';
import { createHarness, type CreateHarnessOptions } from '../runtime/harness.js';
import { createHarnessClientAdapter } from './adapter.js';
import type { HarnessClientAdapter } from './protocol.js';
import { parseAcpMcpDescriptors, proposeAcpMcpLaunches, type AcpMcpHostRule, type AcpMcpStdioDescriptor } from './acp-mcp-admission.js';
import { issueAcpMcpSessionProvider } from './acp-mcp-session.js';
import { prepareMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot } from '../execution/mcp-workspace-snapshot.js';
import { launchDockerMcpGroup, launchDockerMcpTools } from '../execution/mcp-oci-server.js';

async function beforeCancellation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('ACP MCP preparation cancelled.'));
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/** Trusted host composition. Client descriptors never become process arguments
 * without an exact host rule, immutable snapshot and fresh admission receipt. */
export async function createAcpMcpHost(options: {
  harness: CreateHarnessOptions;
  rules: readonly AcpMcpHostRule[];
  authority: Parameters<typeof launchDockerMcpTools>[0]['authority'];
  provisionerImageId: string; hostId: string;
  resolveSecret: Parameters<typeof launchDockerMcpTools>[0]['resolveSecret'];
}) {
  if (options.harness.isolatedMcpSession) throw new Error('ACP host must own its MCP sessions.');
  const rules = structuredClone(options.rules);
  const baseOptions = { ...options.harness };
  const base = await createHarness(baseOptions);
  const workspace = `sha256:${createHash('sha256').update(base.workspace.root).digest('hex')}`;
  const descriptors = new Map<string, readonly AcpMcpStdioDescriptor[]>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  const scopeFor = (runId: string) => ({ principal: base.config.scope.userId!, tenant: base.config.scope.tenantId!, session: runId, workspace });
  try {
    if (!base.config.scope.userId || !base.config.scope.tenantId || !options.hostId) throw new Error('ACP MCP host requires an explicit identity.');
    const adapter = await createHarnessClientAdapter(base, { prepareRun: async context => {
      if (closing) throw new Error('ACP host is closing.');
      const servers = descriptors.get(context.sessionId);
      if (!servers) throw new Error('ACP session has no host registration.');
      if (!servers.length) return { harness: base, release: async () => {} };
      const templates = proposeAcpMcpLaunches(servers, { rules, scope: scopeFor(context.runId), snapshotDigest: workspace });
      const launches: Parameters<typeof launchDockerMcpGroup>[0][number][] = [];
      const snapshots: Awaited<ReturnType<typeof prepareMcpWorkspaceSnapshot>>[] = [];
      let group: Awaited<ReturnType<typeof launchDockerMcpGroup>> | undefined;
      try {
        for (const template of templates) {
          if (context.signal.aborted) throw new Error('ACP MCP preparation cancelled.');
          const snapshot = await prepareMcpWorkspaceSnapshot(base.workspace, template.limits.maxWorkspaceBytes);
          snapshots.push(snapshot);
          const proposal = { ...template, snapshotDigest: snapshot.digest };
          const receipt = await beforeCancellation(options.authority.admit(proposal), context.signal);
          launches.push({ authority: options.authority, receipt, proposal, snapshot, scope: proposal.scope,
            provisionerImageId: options.provisionerImageId, resolveSecret: options.resolveSecret,
            journal: { store: base.store, runId: context.runId, scope: base.config.scope, hostId: options.hostId } });
        }
        group = await launchDockerMcpGroup(launches, context.signal);
        if (context.signal.aborted) throw new Error('ACP MCP preparation cancelled.');
        const runtime = await createHarness({ ...baseOptions, store: base.store, isolatedMcpSession: group.hostSession });
        return { harness: runtime, release: () => runtime.close() };
      } catch {
        const cleanup = await Promise.allSettled([group?.close(), ...snapshots.map(discardMcpWorkspaceSnapshot)]);
        if (cleanup.some(result => result.status === 'rejected')) throw new Error('ACP MCP cleanup was not confirmed.');
        throw new Error('ACP MCP admission or preparation failed.');
      }
    } });
    const exposed: HarnessClientAdapter = {
      negotiate: versions => adapter.negotiate(versions), cancelActive: () => adapter.cancelActive(), close: () => adapter.close(),
      dispatch(request) {
        if (closing) return Promise.resolve({ protocolVersion: 1, requestId: null, ok: false, error: { code: 'CONNECTION_EXPIRED' } });
        const operation = adapter.dispatch(request); pending.add(operation);
        void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
      }
    };
    const mcpSessionProvider = issueAcpMcpSessionProvider({ adapter: exposed,
      parse(input) {
        if (closing || descriptors.size >= 256) throw new Error('ACP MCP host is unavailable.');
        const servers = parseAcpMcpDescriptors(input);
        // Validate exact mapping before allocating a durable ACP session. Scope
        // and snapshot are rebound to the actual run during preparation.
        proposeAcpMcpLaunches(servers, { rules, scope: scopeFor('pending'), snapshotDigest: workspace });
        return servers;
      },
      bind(sessionId, servers) {
        if (closing || descriptors.has(sessionId)) throw new Error('ACP MCP registration is unavailable.');
        descriptors.set(sessionId, servers);
      }
    });
    let closed: Promise<void> | undefined;
    return Object.freeze({ adapter: exposed, workspace: base.workspace.root, mcpSessionProvider,
      close() {
        return closed ??= (async () => {
          closing = true;
          try { await adapter.cancelActive(); await Promise.allSettled([...pending]); adapter.close(); }
          finally { descriptors.clear(); await base.close(); }
        })();
      }
    });
  } catch (error) { await base.close(); throw error; }
}
