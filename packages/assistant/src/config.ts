import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { normalizeHarnessMcpConfiguration } from '@zhivex-ai/harness/engine';
import { compatibleProviderSchema } from './providers/openai-compatible.js';
import { createCalendarModule } from './modules/calendar.js';
import { createMcpModule } from './modules/mcp.js';
import { calendarEnvironment } from './calendar/cli.js';

const moduleId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const schema = z.strictObject({ schemaVersion: z.literal(1), provider: compatibleProviderSchema.optional(),
  modules: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('calendar'), calendarId: z.string().min(1).max(320).default('primary') }),
    z.strictObject({ kind: z.literal('mcp'), id: moduleId, version: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
      instructions: z.string().min(1).max(8192), configuration: z.unknown() })
  ])).max(16).default([]) });
export async function loadAssistantConfig(filename: string) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('ASSISTANT_CONFIG_UNSAFE');
    let parsed: z.infer<typeof schema>;
    try { parsed = schema.parse(JSON.parse(await handle.readFile('utf8'))); } catch { throw new Error('ASSISTANT_CONFIG_INVALID'); }
    const ids = new Set<string>();
    const modules = parsed.modules.map(module => {
      const id = module.kind === 'calendar' ? 'calendar' : module.id;
      if (ids.has(id)) throw new Error('ASSISTANT_MODULE_ID_INVALID'); ids.add(id);
      if (module.kind === 'calendar') return createCalendarModule(calendarEnvironment(module.calendarId));
      let configuration;
      try { configuration = normalizeHarnessMcpConfiguration(module.configuration); } catch { throw new Error('ASSISTANT_MCP_CONFIG_INVALID'); }
      if (configuration.servers.some(server => server.transport !== 'http')) throw new Error('ASSISTANT_CONFIG_CUSTOM_CLIENT_FORBIDDEN');
      return createMcpModule({ ...module, configuration });
    });
    return { ...(parsed.provider ? { compatibleProvider: parsed.provider } : {}), modules, hasCalendar: ids.has('calendar') };
  } finally { await handle.close(); }
}
