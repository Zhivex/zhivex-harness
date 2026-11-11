import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createProviderModel } from '@zhivex-ai/harness/engine';
import { compatibleProviderSchema, createCompatibleProvider, parseCompatibleProvider } from './openai-compatible.js';

export const qwenServices = ['model-studio', 'qwencloud', 'token-plan'] as const;
const qwenCloudEndpoints = { qwencloud: 'https://maas.qwencloudapi.com/compatible-mode/v1', 'token-plan': 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1' } as const;
export const qwenRegions = ['singapore', 'beijing', 'hong-kong', 'tokyo', 'frankfurt', 'virginia'] as const;
const model = z.string().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/);
const apiKeyEnv = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const nativeProviderSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('meta'), model, apiKeyEnv }),
  z.strictObject({ kind: z.literal('qwen'), model, apiKeyEnv, service: z.enum(qwenServices).optional(), region: z.enum(qwenRegions).default('singapore'),
    workspaceId: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/).optional() }).refine(config => config.service && config.service !== 'model-studio' ? config.region === 'singapore' && !config.workspaceId : config.region === 'singapore' || Boolean(config.workspaceId), 'A regional workspace requires its workspace ID.')
]);
export const assistantProviderSchema = z.union([compatibleProviderSchema, nativeProviderSchema]);
export type AssistantProviderConfig = z.input<typeof assistantProviderSchema>;
export function parseAssistantProvider(input: unknown) {
  const parsed = assistantProviderSchema.safeParse(input);
  if (!parsed.success) throw new Error('ASSISTANT_PROVIDER_CONFIG_INVALID');
  return parsed.data.kind === 'openai-compatible' ? parseCompatibleProvider(parsed.data) : parsed.data;
}

/** Credentials stay outside the configuration digest and the process environment. */
export function createAssistantProvider(input: AssistantProviderConfig, options: { env?: NodeJS.ProcessEnv } = {}) {
  const config = parseAssistantProvider(input);
  if (config.kind === 'openai-compatible') return { ...createCompatibleProvider(config, options), provider: 'openai' as const };
  const key = (options.env ?? process.env)[config.apiKeyEnv]?.trim();
  if (!key) throw new Error('ASSISTANT_PROVIDER_CREDENTIAL_MISSING');
  const env: NodeJS.ProcessEnv = config.kind === 'meta' ? { MODEL_API_KEY: key } : {
    DASHSCOPE_API_KEY: key, ...(config.service && config.service !== 'model-studio' ? { QWEN_BASE_URL: qwenCloudEndpoints[config.service] } : {}), QWEN_REGION: config.region, ...(config.workspaceId ? { QWEN_WORKSPACE_ID: config.workspaceId } : {})
  };
  return { config, provider: config.kind, model: createProviderModel({ provider: config.kind, model: config.model }, env),
    binding: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}
