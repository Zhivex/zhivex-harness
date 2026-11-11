import { z } from 'zod';
import { normalizeHarnessMcpConfiguration } from '@zhivex-ai/harness/engine';
import { calendarEnvironment } from '../calendar/cli.js';
import { createCalendarModule } from './calendar.js';
import { createMcpModule } from './mcp.js';
import { createDailyModule } from './daily.js';
import { createGoogleModule } from './google.js';
import { createGithubModule } from './github.js';
import { createWebModule } from './web.js';
import type { AssistantModule } from './module.js';

const environment = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const dailyIntegrationSchema = z.strictObject({ daily: z.boolean().default(false),
  github: z.strictObject({ account: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), authorizationEnv: z.string().regex(/^ZHIVEX_MCP_[A-Z0-9_]{1,100}$/) }).optional(),
  web: z.strictObject({ apiKeyEnv: environment }).optional() });
export const moduleConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('calendar'), calendarId: z.string().min(1).max(320).default('primary') }),
  z.strictObject({ kind: z.literal('daily') }),
  z.strictObject({ kind: z.literal('google'), mail: z.boolean().default(false), drive: z.boolean().default(false) }).refine(v => v.mail || v.drive),
  z.strictObject({ kind: z.literal('github'), ...dailyIntegrationSchema.shape.github.unwrap().shape }),
  z.strictObject({ kind: z.literal('web'), apiKeyEnv: environment }),
  z.strictObject({ kind: z.literal('mcp'), id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), version: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), instructions: z.string().min(1).max(8192), configuration: z.unknown() })
]);
export function configuredModules(input: z.infer<typeof moduleConfigSchema>[]): AssistantModule[] {
  const ids = new Set<string>();
  return input.map(module => {
    const id = module.kind === 'mcp' ? module.id : module.kind;
    if (ids.has(id)) throw new Error('ASSISTANT_MODULE_ID_INVALID'); ids.add(id);
    switch (module.kind) {
      case 'calendar': return createCalendarModule(calendarEnvironment(module.calendarId));
      case 'daily': return createDailyModule();
      case 'google': return createGoogleModule({ ...calendarEnvironment(), mail: module.mail, drive: module.drive });
      case 'github': return createGithubModule(module);
      case 'web': return createWebModule(module);
      case 'mcp': {
        let configuration;
        try { configuration = normalizeHarnessMcpConfiguration(module.configuration); } catch { throw new Error('ASSISTANT_MCP_CONFIG_INVALID'); }
        if (configuration.servers.some(server => server.transport !== 'http')) throw new Error('ASSISTANT_CONFIG_CUSTOM_CLIENT_FORBIDDEN');
        return createMcpModule({ ...module, configuration });
      }
    }
  });
}
