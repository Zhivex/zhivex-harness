import { consumeMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot, type McpWorkspaceSnapshot } from '../execution/mcp-workspace-snapshot.js';
import { McpStdioAdmissionError, type createMcpStdioAdmissionAuthority, type McpStdioLaunchProposal, type McpStdioLaunchReceipt } from './mcp-stdio-admission.js';

type Authority = ReturnType<typeof createMcpStdioAdmissionAuthority>;
type SnapshotFiles = Parameters<Parameters<typeof consumeMcpWorkspaceSnapshot>[2]>[0];

/** Trusted host handoff only. The seeder owns creation, OCI attestation and cleanup. */
export async function withAdmittedMcpLaunch<T>(options: {
  authority: Authority;
  receipt: McpStdioLaunchReceipt;
  proposal: unknown;
  snapshot: McpWorkspaceSnapshot;
  /** Supplied by the authenticated host session, never copied from proposal input. */
  scope: McpStdioLaunchProposal['scope'];
  resolveSecret: (reference: string, signal: AbortSignal) => Promise<string | undefined>;
  seed: (launch: { proposal: Readonly<McpStdioLaunchProposal>; environment: Readonly<Record<string, string>>; files: SnapshotFiles }) => Promise<T>;
}): Promise<T> {
  let result: T | undefined;
  try {
    // Consume before any secret lookup, boundary creation or workspace seeding.
    const proposal = options.authority.consume(options.receipt, options.proposal);
    for (const key of ['principal', 'tenant', 'session', 'workspace'] as const) {
      if (proposal.scope[key] !== options.scope[key]) throw new McpStdioAdmissionError('MCP launch scope changed.');
    }
    await consumeMcpWorkspaceSnapshot(options.snapshot, { snapshotDigest: proposal.snapshotDigest,
      workspace: options.scope.workspace, maxWorkspaceBytes: proposal.limits.maxWorkspaceBytes }, async files => {
      // Keep secret values out of proposals, fingerprints and argv. No inherited
      // process environment is available to the isolated server through this map.
      const environment: Record<string, string> = { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', HOSTNAME: 'mcp', ...proposal.environment };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let secretBytes = 0;
      try {
        await Promise.race([
          (async () => {
            for (const [name, reference] of Object.entries(proposal.secretReferences)) {
              const value = await options.resolveSecret(reference, controller.signal);
              if (controller.signal.aborted) throw new Error('expired');
              if (typeof value !== 'string' || value.length === 0 || /[\x00\r\n]/.test(value)) throw new Error('invalid');
              secretBytes += new TextEncoder().encode(value).byteLength;
              if (secretBytes > 32 * 1024) throw new Error('limit');
              environment[name] = value;
            }
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(new Error('expired'));
          }, 5000); })
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
      result = await options.seed({ proposal, environment: Object.freeze(environment), files });
    });
    return result as T;
  } catch {
    // Seeders may expose container/server or credential diagnostics. Sanitize all
    // of them here; runtime cleanup failures must be audited separately by owner.
    throw new McpStdioAdmissionError('MCP admitted launch handoff failed.');
  } finally {
    await discardMcpWorkspaceSnapshot(options.snapshot);
  }
}
