import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createOpenAI, openAIWebSearchTool } from '@zhivex-ai/openai';
import { wrapLanguageModel } from '@zhivex-ai/core';
import { citeResponseText } from './web-citations.js';

export const compatibleProviderSchema = z.strictObject({
  kind: z.literal('openai-compatible'),
  baseURL: z.string().url().max(2048),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  model: z.string().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/),
  apiMode: z.enum(['chat', 'responses']),
  webSearch: z.literal(true).optional(),
  allowInsecureLocalhost: z.boolean().default(false),
  capabilities: z.strictObject({ streaming: z.literal(true), tools: z.literal(true),
    toolChoice: z.boolean().default(false), parallelToolCalls: z.boolean().default(false),
    structuredOutput: z.boolean().default(false), jsonMode: z.boolean().default(false), reasoning: z.boolean().default(false) })
}).superRefine((config, ctx) => {
  const url = new URL(config.baseURL);
  if (config.webSearch && (config.apiMode !== 'responses' || config.baseURL.replace(/\/+$/, '') !== 'https://api.openai.com/v1')) {
    ctx.addIssue({ code: 'custom', message: 'Web search requires official OpenAI Responses.' });
  }
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
    fetch: ((input, init) => {
      // Keep the SDK's chat request consistent with the onboarding probe. OpenAI's
      // current models reject the legacy max_tokens field emitted by this SDK.
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      let body = init?.body;
      if (target.origin === 'https://api.openai.com' && target.pathname.endsWith('/chat/completions') && typeof body === 'string') {
        const payload = JSON.parse(body);
        if (payload.max_tokens !== undefined) {
          payload.max_completion_tokens ??= payload.max_tokens;
          delete payload.max_tokens;
          body = JSON.stringify(payload);
        }
      }
      return transport(input, { ...init, ...(body !== undefined ? { body } : {}), redirect: 'error' });
    }) as typeof globalThis.fetch,
    modelCapabilities: { [config.model]: { ...config.capabilities, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, webSearch: Boolean(config.webSearch), explicitPromptCaching: false, agentCapabilities: { approvalRequests: false, hostedWebSearch: Boolean(config.webSearch), hostedFileSearch: false, remoteMcp: false, computerUse: false, codeExecution: false, toolsets: false } } } });
  const model = wrapLanguageModel(adapter(config.model), [{ name: 'assistant-compatible-protocol-v1',
    async wrapGenerate({ input }, next) {
      input.providerOptions = { ...input.providerOptions, apiMode: config.apiMode, ...(config.webSearch ? { include: ['web_search_call.action.sources'] } : {}) }; input.toolResultFormat = 'envelope';
      if (config.webSearch) input.tools = { ...input.tools, web_search: openAIWebSearchTool() };
      const result = await next();
      if (!config.webSearch) return result;
      const cited = citeResponseText(result.text ?? '', result.rawResponse);
      return { ...result, text: cited, messages: (result.messages ?? []).map(message => ({ ...message, parts: message.parts.map(part => part.type === 'text' ? { ...part, text: citeResponseText(part.text, result.rawResponse) } : part) })) };
    },
    async wrapStream({ input }, next) {
      input.providerOptions = { ...input.providerOptions, apiMode: config.apiMode, ...(config.webSearch ? { include: ['web_search_call.action.sources'] } : {}) }; input.toolResultFormat = 'envelope';
      if (config.webSearch) input.tools = { ...input.tools, web_search: openAIWebSearchTool() };
      const stream = await next();
      if (!config.webSearch) return stream;
      return (async function* () {
        let text = ''; const output: unknown[] = [];
        for await (const event of stream) {
          if (event.type === 'text-delta') { text += event.textDelta; continue; }
          if (event.type === 'provider-data' && event.provider === 'openai') {
            const data = event.data as { type?: string; items?: unknown[] };
            if (data?.type === 'responses_output' && Array.isArray(data.items)) output.push(...data.items);
          }
          if (event.type === 'finish' && text) { yield { type: 'text-delta' as const, textDelta: citeResponseText(text, { output }) }; text = ''; }
          yield event;
        }
        if (text) yield { type: 'text-delta' as const, textDelta: citeResponseText(text, { output }) };
      })();
    }
  }]);
  return { model, config, binding: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}
