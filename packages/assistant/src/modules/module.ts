import { createHash } from 'node:crypto';
import { GENERAL_ASSISTANT_PROFILE, harnessAgentProfileSchema, normalizeHarnessMcpConfiguration, type CreateProfiledHarnessOptions, type HarnessAgentProfile } from '@zhivex-ai/harness/engine';
import type { HarnessClientRun } from '@zhivex-ai/harness/protocol';
import type { AgendaSource } from '../automation/summary.js';
import type { DailyService, NotificationDelivery } from '../daily/service.js';
export interface SummarySource { id: string; read(signal: AbortSignal): Promise<string> }

export interface AssistantModuleContext { directory: string; ownerId: string; recover: boolean }
export interface AssistantModuleInstance {
  /** Non-secret, stable connection/configuration identity. Change when permissions or account change. */
  binding: string;
  /** Built-in legacy profile compatibility; module must already bind its identity in that profile. */
  preserveProfile?: boolean;
  profile: HarnessAgentProfile;
  mcpConfiguration: NonNullable<CreateProfiledHarnessOptions['mcpConfiguration']>;
  mcpClients?: NonNullable<CreateProfiledHarnessOptions['mcpClients']>;
  reviewTools?: readonly string[];
  approvalDetails?: (run: HarnessClientRun) => Promise<unknown[]>;
  agendaSource?: AgendaSource;
  summarySources?: SummarySource[];
  daily?: DailyService;
  start?(context: { notifications?: NotificationDelivery }): void;
  close(): Promise<void>;
}
/** Trusted application code, not a sandbox or a module loader controlled by chat. */
export interface AssistantModule {
  id: string;
  version: string;
  open(context: AssistantModuleContext): Promise<AssistantModuleInstance>;
}
export async function openAssistantModules(modules: readonly AssistantModule[], context: AssistantModuleContext) {
  const ids = new Set<string>();
  for (const module of modules) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(module.id) || !/^[A-Za-z0-9.-]{1,64}$/.test(module.version) || ids.has(module.id)) throw new Error('ASSISTANT_MODULE_ID_INVALID');
    ids.add(module.id);
  }
  const opened: { definition: AssistantModule; instance: AssistantModuleInstance }[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    const results = await Promise.allSettled([...opened].reverse().map(async item => item.instance.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('ASSISTANT_MODULE_CLOSE_FAILED');
  };
  try {
    const servers: ReturnType<typeof normalizeHarnessMcpConfiguration>['servers'][number][] = [];
    const clients: Record<string, NonNullable<CreateProfiledHarnessOptions['mcpClients']>[string]> = {};
    const names = new Set<string>(), toolNames = new Set<string>(), reviewTools: string[] = [];
    let agendaSource: AgendaSource | undefined, daily: DailyService | undefined;
    const summarySources: SummarySource[] = [];
    for (const definition of [...modules].sort((a,b) => a.id.localeCompare(b.id))) {
      const instance = await definition.open(context); opened.push({ definition, instance });
      harnessAgentProfileSchema.parse(instance.profile);
      if (!instance.binding || instance.binding.length > 8192) throw new Error('ASSISTANT_MODULE_BINDING_INVALID');
      const config = normalizeHarnessMcpConfiguration(instance.mcpConfiguration);
      const exposed = new Set<string>();
      for (const server of config.servers) {
        if (!server.name.startsWith(`${definition.id}_`) || names.has(server.name) || !server.includeTools.length || server.includeResources?.length || server.excludeTools.length || server.toolNamePrefix !== `${server.name}_`) throw new Error('ASSISTANT_MODULE_NAMESPACE_INVALID');
        names.add(server.name); servers.push(server);
        for (const tool of server.includeTools) {
          if (!/^[A-Za-z0-9_]+$/.test(tool)) throw new Error('ASSISTANT_MODULE_TOOL_INVALID');
          exposed.add(`${server.name}_${tool}`);
        }
        if (server.transport === 'custom' && !instance.mcpClients?.[server.name]) throw new Error('ASSISTANT_MODULE_CLIENT_MISSING');
      }
      for (const [name, client] of Object.entries(instance.mcpClients ?? {})) {
        if (!config.servers.some(server => server.name === name && server.transport === 'custom')) throw new Error('ASSISTANT_MODULE_CLIENT_INVALID');
        clients[name] = client;
      }
      if (instance.profile.toolNames.length !== exposed.size) throw new Error('ASSISTANT_MODULE_TOOL_INVALID');
      for (const name of instance.profile.toolNames) {
        if (!exposed.has(name) || toolNames.has(name)) throw new Error('ASSISTANT_MODULE_TOOL_COLLISION'); toolNames.add(name);
      }
      for (const tool of instance.reviewTools ?? []) {
        if (!exposed.has(tool) || !instance.approvalDetails) throw new Error('ASSISTANT_MODULE_REVIEW_INVALID'); reviewTools.push(tool);
      }
      if (instance.agendaSource) { if (agendaSource) throw new Error('ASSISTANT_MODULE_AGENDA_AMBIGUOUS'); agendaSource = instance.agendaSource; }
      if (instance.daily) { if (daily) throw new Error('ASSISTANT_MODULE_DAILY_AMBIGUOUS'); daily = instance.daily; }
      for (const source of instance.summarySources ?? []) summarySources.push({ ...source, id: `${definition.id}:${source.id}` });
    }
    const identity = opened.map(({ definition, instance }) => ({ id: definition.id, version: definition.version, binding: instance.binding }));
    // A sole module owns its versioned profile, retaining Calendar v1 recovery compatibility.
    const profile = opened.length === 1 && opened[0]!.definition.id === 'calendar' && opened[0]!.definition.version === '1' && opened[0]!.instance.preserveProfile ? opened[0]!.instance.profile : {
      ...GENERAL_ASSISTANT_PROFILE, id: 'modular-assistant', version: '1', toolNames: [...toolNames].sort(),
      instructions: GENERAL_ASSISTANT_PROFILE.instructions + '\nModule configuration: ' + JSON.stringify(identity) + '\n' + opened.map(({ definition, instance }) => `[${definition.id}@${definition.version}]\n${instance.profile.instructions}`).join('\n')
    };
    // Composite identity is bound into the profile; Calendar v1 already binds its connection.
    const binding = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    return { profile, binding, identity, reviewTools, agendaSource, daily, summarySources, close,
      start(context: { notifications?: NotificationDelivery }) { for (const { instance } of opened) instance.start?.(context); },
      engine: { agentProfile: profile, mcpConfiguration: { schemaVersion: 1 as const, servers }, mcpClients: clients },
      approvalDetails: async (run: HarnessClientRun) => {
        const results: unknown[] = [];
        for (const { instance } of opened) if (instance.approvalDetails) results.push(...await instance.approvalDetails(run));
        return results;
      }
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
