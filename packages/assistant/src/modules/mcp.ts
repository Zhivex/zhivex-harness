import { createHash } from 'node:crypto';
import { GENERAL_ASSISTANT_PROFILE, normalizeHarnessMcpConfiguration } from '@zhivex-ai/harness/engine';
import type { AssistantModule, AssistantModuleInstance } from './module.js';

/** Fixed allowlist of MCP tools; permissions remain enforced by Harness. No dynamic imports. */
export function createMcpModule(options: {
  id: string; version: string; instructions: string; configuration: AssistantModuleInstance['mcpConfiguration'];
  clients?: AssistantModuleInstance['mcpClients']; binding?: string; close?: () => Promise<void>;
}): AssistantModule {
  return { id: options.id, version: options.version, async open() {
    const config = normalizeHarnessMcpConfiguration(options.configuration);
    const binding = createHash('sha256').update(JSON.stringify({ config, binding: options.binding ?? '' })).digest('hex');
    return { binding, profile: { ...GENERAL_ASSISTANT_PROFILE, id: `module-${options.id.replaceAll('_', '-')}`, version: options.version,
      instructions: GENERAL_ASSISTANT_PROFILE.instructions + '\n' + options.instructions,
      toolNames: config.servers.flatMap(server => server.includeTools.map(tool => `${server.name}_${tool}`)) },
      mcpConfiguration: config, ...(options.clients ? { mcpClients: options.clients } : {}), async close() { await options.close?.(); } };
  } };
}
