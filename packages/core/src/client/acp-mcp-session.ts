import type { HarnessClientAdapter } from './protocol.js';
import type { AcpMcpStdioDescriptor } from './acp-mcp-admission.js';

export type AcpMcpSessionProvider = Readonly<Record<never, never>>;
const providers = new WeakMap<object, {
  adapter: HarnessClientAdapter;
  parse(input: unknown): readonly AcpMcpStdioDescriptor[];
  bind(sessionId: string, servers: readonly AcpMcpStdioDescriptor[]): void;
}>();

/** Internal issuer. Only the wired host factory exports a provider capability. */
export function issueAcpMcpSessionProvider(provider: {
  adapter: HarnessClientAdapter;
  parse(input: unknown): readonly AcpMcpStdioDescriptor[];
  bind(sessionId: string, servers: readonly AcpMcpStdioDescriptor[]): void;
}): AcpMcpSessionProvider {
  const token = Object.freeze({}); providers.set(token, provider); return token;
}
export function resolveAcpMcpSessionProvider(token: AcpMcpSessionProvider, adapter: HarnessClientAdapter) {
  const provider = providers.get(token);
  if (!provider || provider.adapter !== adapter) throw new Error('ACP MCP requires its host-owned adapter capability.');
  return provider;
}
