import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createOpenAI } from '@zhivex-ai/openai';
import { wrapLanguageModel } from '@zhivex-ai/core';

export const compatibleProviderSchema = z.strictObject({
  kind: z.literal('openai-compatible'),
  baseURL: z.string().url().max(2048),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  model: z.string().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/),
  apiMode: z.enum(['chat', 'responses']),
  allowInsecureLocalhost: z.boolean().default(false),
  capabilities: z.strictObject({ streaming: z.literal(true), tools: z.literal(true),
    toolChoice: z.boolean().default(false), parallelToolCalls: z.boolean().default(false),
    structuredOutput: z.boolean().default(false), jsonMode: z.boolean().default(false), reasoning: z.boolean().default(false) })
}).superRefine((config, ctx) => {
  const url = new URL(config.baseURL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && local && config.allowInsecureLocalhost))) {
    ctx.addIssue({ code: 'custom', message: 'Expected HTTPS without embedded credentials/query; loopback HTTP requires explicit opt-in.' });
  }
});
export type CompatibleProviderConfig = z.input<typeof compatibleProviderSchema>;
export function parseCompatibleProvider(input: unknown) {
  const result = compatibleProviderSchema.safeParse(input);
  if (!result.success) throw new Error('ASSISTANT_PROVIDER_CONFIG_INVALID');
  return { ...result.data, baseURL: result.data.baseURL.replace(/\/+$/, '') };
}
export function createCompatibleProvider(input: CompatibleProviderConfig, options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {}) {
  const config = parseCompatibleProvider(input), apiKey = (options.env ?? process.env)[config.apiKeyEnv];
  if (!apiKey?.trim()) throw new Error('ASSISTANT_PROVIDER_CREDENTIAL_MISSING');
  const transport = options.fetcher ?? globalThis.fetch;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseURL).hostname);
  const adapter = createOpenAI({ apiKey, baseURL: config.baseURL,
    ...(config.allowInsecureLocalhost && local ? { allowUnsafeEndpoints: true } : {}),
    fetch: ((input, init) => transport(input, { ...init, redirect: 'error' })) as typeof globalThis.fetch,
    modelCapabilities: { [config.model]: { ...config.capabilities, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, webSearch: false, explicitPromptCaching: false, agentCapabilities: { approvalRequests: false, hostedWebSearch: false, hostedFileSearch: false, remoteMcp: false, computerUse: false, codeExecution: false, toolsets: false } } } });
  const model = wrapLanguageModel(adapter(config.model), [{ name: 'assistant-compatible-protocol-v1',
    async wrapGenerate({ input }, next) { input.providerOptions = { ...input.providerOptions, apiMode: config.apiMode }; input.toolResultFormat = 'envelope'; return next(); },
    async wrapStream({ input }, next) { input.providerOptions = { ...input.providerOptions, apiMode: config.apiMode }; input.toolResultFormat = 'envelope'; return next(); }
  }]);
  return { model, config, binding: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}
