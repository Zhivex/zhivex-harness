import { createHash } from 'node:crypto';
import { z } from 'zod';
import { microsoftConfigSchema } from '../microsoft/connection.js';
import { dailyIntegrationSchema } from '../modules/catalog.js';
import { qwenRegions, qwenServices } from '../providers/provider.js';
export const secret = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const compatibleSetupSchema = z.strictObject({
  baseURL: z.string().url().max(2048),
  model: z.string().min(1).max(200),
  apiKey: secret,
  apiMode: z.enum(['chat', 'responses']).default('chat'),
  webSearch: z.literal(true).optional(),
  allowInsecureLocalhost: z.boolean().default(false),
});
export const providerSchema = z.union([
  compatibleSetupSchema,
  z.strictObject({ kind: z.literal('meta'), model: z.string().min(1).max(200), apiKey: secret }),
  z.strictObject({
    kind: z.literal('qwen'),
    service: z.enum(qwenServices).optional(),
    model: z.string().min(1).max(200),
    apiKey: secret,
    region: z.enum(qwenRegions).default('singapore'),
    workspaceId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
      .optional(),
  }),
]);
export const calendarSchema = z.strictObject({
  clientId: z.string().max(320).endsWith('.apps.googleusercontent.com'),
  clientSecret: z.string().max(1024).optional(),
});
const googleSchema = calendarSchema.extend({
  encryptionKey: z.string(),
  email: z.string().optional(),
  mail: z.boolean(),
  drive: z.boolean(),
});
export const agentName = z.string().trim().min(1).max(80);
const profileSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  name: agentName,
  microsoft: microsoftConfigSchema
    .safeExtend({ encryptionKey: z.string(), email: z.string().optional() })
    .optional(),
  tools: dailyIntegrationSchema.optional(),
  google: googleSchema.optional(),
  connectionId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  profileWebSearch: z.boolean().optional(),
  profileBinding: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  provider: providerSchema.optional(),
  calendar: calendarSchema
    .extend({ encryptionKey: z.string(), email: z.string().optional() })
    .optional(),
  telegram: z
    .strictObject({
      token: secret,
      userId: z.string(),
      offset: z.number().int().nonnegative().safe(),
      username: z.string(),
    })
    .optional(),
});
const savedSchema = z.strictObject({
  version: z.literal(1),
  active: z.string().optional(),
  draft: profileSchema.optional(),
  profiles: z.array(profileSchema).max(50),
  connections: z
    .array(z.strictObject({ id: z.string(), provider: providerSchema }))
    .max(200)
    .optional(),
});
export type Profile = z.infer<typeof profileSchema>;
export type Saved = z.infer<typeof savedSchema>;
// Persist API keys once; profiles retain only a reference and their model settings.
export const connectionId = (provider: NonNullable<Profile['provider']>) => {
  const { model: _, ...scope } = provider;
  const {
    apiMode: _mode,
    webSearch: _search,
    ...identity
  } = scope as typeof scope & {
    apiMode?: string;
    webSearch?: boolean;
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
};
export const profileConnectionId = (p: Profile) =>
  p.connectionId ?? (p.provider ? connectionId(p.provider) : undefined);
export const connectionsFor = (saved: Saved) => {
  const entries = new Map<string, NonNullable<Profile['provider']>>(
    (saved.connections ?? []).map((c) => [c.id, c.provider]),
  );
  for (const p of [...saved.profiles, ...(saved.draft ? [saved.draft] : [])])
    if (p.provider) entries.set(profileConnectionId(p)!, p.provider);
  return entries;
};
export const encodeSaved = (saved: Saved) => {
  const profile = (p: Profile) => {
    if (!p.provider) return p;
    const { apiKey: _, ...config } = p.provider;
    return { ...p, provider: { ...config, connectionId: profileConnectionId(p) } };
  };
  return JSON.stringify({
    ...saved,
    version: 2,
    profiles: saved.profiles.map(profile),
    ...(saved.draft ? { draft: profile(saved.draft) } : {}),
    connections: [...connectionsFor(saved)].map(([id, provider]) => {
      const { apiKey, ...config } = provider;
      return { id, apiKey, provider: config };
    }),
  });
};
export const decodeSaved = (text: string): Saved => {
  const raw = JSON.parse(text);
  if (raw.version === 1) return savedSchema.parse(raw);
  const refProfile = profileSchema.extend({
    provider: z.record(z.string(), z.unknown()).optional(),
  });
  const stored = z
    .strictObject({
      version: z.literal(2),
      active: z.string().optional(),
      draft: refProfile.optional(),
      profiles: z.array(refProfile).max(50),
      connections: z
        .array(
          z.strictObject({
            id: z.string(),
            apiKey: secret,
            provider: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .max(200),
    })
    .parse(raw);
  const profile = (p: z.infer<typeof refProfile>) => {
    if (!p.provider) return p;
    const { connectionId: id, ...config } = p.provider;
    const connection = stored.connections.find((c) => c.id === id);
    if (!connection) throw new Error('SETUP_CONNECTION_NOT_FOUND');
    return {
      ...p,
      connectionId: connection.id,
      provider: { ...config, apiKey: connection.apiKey },
    };
  };
  const hydrated = savedSchema.parse({
    version: 1,
    active: stored.active,
    profiles: stored.profiles.map(profile),
    ...(stored.draft ? { draft: profile(stored.draft) } : {}),
    connections: stored.connections
      .filter((c) => c.provider)
      .map((c) => ({ id: c.id, provider: { ...c.provider, apiKey: c.apiKey } })),
  });
  return {
    ...hydrated,
    connections: [...connectionsFor(hydrated)].map(([id, provider]) => ({ id, provider })),
  };
};
