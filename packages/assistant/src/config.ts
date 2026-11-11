import { taskMetricsPricingSchema } from './task-metrics.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { moduleConfigSchema, configuredModules } from './modules/catalog.js';
import type { AssistantHostOptions } from './host.js';
import { assistantProviderSchema } from './providers/provider.js';

const schema = z.strictObject({ schemaVersion: z.literal(1), provider: assistantProviderSchema.optional(),
  taskMetricsPricing: taskMetricsPricingSchema.optional(), modules: z.array(moduleConfigSchema).max(16).default([]) });
export async function loadAssistantConfig(filename: string): Promise<Pick<AssistantHostOptions, 'compatibleProvider' | 'assistantProvider' | 'taskMetricsPricing'> & { modules: import('./modules/module.js').AssistantModule[]; hasCalendar: boolean; google?: { mail: boolean; drive: boolean } }> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('ASSISTANT_CONFIG_UNSAFE');
    let parsed: z.infer<typeof schema>;
    try { parsed = schema.parse(JSON.parse(await handle.readFile('utf8'))); } catch { throw new Error('ASSISTANT_CONFIG_INVALID'); }
    const modules = configuredModules(parsed.modules);
    const google = parsed.modules.find(module => module.kind === 'google');
    return { ...(parsed.taskMetricsPricing ? { taskMetricsPricing: parsed.taskMetricsPricing } : {}), ...(parsed.provider ? parsed.provider.kind === 'openai-compatible' ? { compatibleProvider: parsed.provider } : { assistantProvider: parsed.provider } : {}), modules, hasCalendar: parsed.modules.some(module => module.kind === 'calendar'), ...(google ? { google: { mail: google.mail, drive: google.drive } } : {}) };
  } finally { await handle.close(); }
}
