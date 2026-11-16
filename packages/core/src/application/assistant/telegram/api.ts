import { z } from 'zod';

const numericId = z.number().int().positive().safe();
const user = z.object({ id: numericId, is_bot: z.boolean().optional() });
const message = z.object({ message_id: numericId, from: user.optional(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }), text: z.string().max(16_000).optional() });
export const updateSchema = z.object({ update_id: z.number().int().nonnegative().safe(),
  message: message.optional(), callback_query: z.object({ id: z.string().max(256), from: user,
    message: message.optional(), data: z.string().max(64).optional() }).optional() }).refine(value => !(value.message && value.callback_query), 'Ambiguous update');
export type TelegramUpdate = z.infer<typeof updateSchema>;
export interface TelegramApi { call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }
export class TelegramFailure extends Error {
  constructor(readonly kind: 'retry' | 'rejected' | 'uncertain', readonly retryAfter = 0) { super(`TELEGRAM_${kind.toUpperCase()}`); }
}

/** Token remains only in memory. Never propagate fetch errors containing request URLs. */
export function createTelegramApi(token: string, fetcher: typeof fetch = fetch): TelegramApi {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('TELEGRAM_TOKEN_INVALID');
  const allowed = new Set(['getMe', 'getUpdates', 'getWebhookInfo', 'sendMessage', 'answerCallbackQuery']);
  return { async call(method, payload, signal) {
    if (!allowed.has(method)) throw new Error('TELEGRAM_METHOD_INVALID');
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000)
      });
      if (!response.body) throw new TelegramFailure('uncertain');
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) { const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new TelegramFailure('uncertain'); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (result.ok !== true) {
        if (result.error_code === 429 && Number.isSafeInteger(result.parameters?.retry_after) && result.parameters.retry_after > 0) {
          throw new TelegramFailure('retry', result.parameters.retry_after * 1000);
        }
        throw new TelegramFailure(result.error_code >= 400 && result.error_code < 500 ? 'rejected' : 'uncertain');
      }
      if (!response.ok) throw new TelegramFailure('uncertain');
      return result.result;
    } catch (error) { if (error instanceof TelegramFailure) throw error; throw new TelegramFailure('uncertain'); }
  } };
}
