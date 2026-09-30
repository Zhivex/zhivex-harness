import { z } from 'zod';
import type { McpStdioLaunchProposal } from '../integrations/mcp-stdio-admission.js';

const literal = z.string().max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const command = literal.refine(value => value.startsWith('/') && !value.includes('\\') &&
  value.split('/').slice(1).every(part => part && part !== '.' && part !== '..'));
const descriptor = z.object({
  name: z.string().min(1).max(128), command, args: z.array(literal).max(128),
  env: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), value: literal }).strict()).max(64)
}).strict();
export type AcpMcpStdioDescriptor = z.infer<typeof descriptor>;

/** ACP v1 request data, never executable host configuration. */
export function parseAcpMcpDescriptors(input: unknown): readonly AcpMcpStdioDescriptor[] {
  const parsed = z.array(descriptor).max(8).safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 64 * 1024) throw new Error('Invalid ACP MCP configuration.');
  const servers = parsed.data;
  if (new Set(servers.map(server => server.name)).size !== servers.length || servers.some(server =>
    new Set(server.env.map(variable => variable.name)).size !== server.env.length)) throw new Error('Ambiguous ACP MCP configuration.');
  return Object.freeze(servers.map(server => Object.freeze({ ...server,
    args: Object.freeze([...server.args]) as unknown as string[],
    env: Object.freeze(server.env.map(variable => Object.freeze({ ...variable }))) as unknown as typeof server.env
  })));
}

export interface AcpMcpHostRule {
  /** Exact client command/argv mapped to a host-provisioned immutable image. */
  clientCommand: string;
  clientArgs: readonly string[];
  clientName: string;
  proposal: Omit<McpStdioLaunchProposal, 'scope' | 'snapshotDigest'>;
  /** Explicit client env -> admitted ZHIVEX_MCP_* name translation. */
  environmentBindings: Readonly<Record<string, string>>;
}

/** Pure translation. It cannot authorize, spawn, read secrets or choose a snapshot.
 * The returned proposals must still cross the host's MCP admission authority.
 */
export function proposeAcpMcpLaunches(input: unknown, options: {
  rules: readonly AcpMcpHostRule[];
  scope: McpStdioLaunchProposal['scope']; snapshotDigest: string;
}): readonly McpStdioLaunchProposal[] {
  const servers = parseAcpMcpDescriptors(input);
  const proposals = servers.map(server => {
    const matching = options.rules.filter(rule => rule.clientName === server.name && rule.clientCommand === server.command &&
      JSON.stringify(rule.clientArgs) === JSON.stringify(server.args));
    if (matching.length !== 1) throw new Error('ACP MCP server has no unique host mapping.');
    const rule = matching[0]!;
    const environment = { ...rule.proposal.environment };
    const targets = new Set<string>();
    for (const variable of server.env) {
      const target = Object.hasOwn(rule.environmentBindings, variable.name) ? rule.environmentBindings[variable.name] : undefined;
      if (!target || !/^ZHIVEX_MCP_[A-Z0-9_]{1,96}$/.test(target) || targets.has(target) ||
          Object.hasOwn(environment, target) || Object.hasOwn(rule.proposal.secretReferences, target)) {
        throw new Error('ACP MCP environment was not uniquely allowed by the host.');
      }
      targets.add(target); environment[target] = variable.value;
    }
    return structuredClone({ ...rule.proposal, environment, scope: options.scope, snapshotDigest: options.snapshotDigest });
  });
  if (new Set(proposals.map(proposal => proposal.serverId)).size !== proposals.length) throw new Error('ACP MCP host mappings collide.');
  return proposals;
}
