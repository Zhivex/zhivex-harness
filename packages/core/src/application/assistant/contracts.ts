import { z } from "zod";

/** Draft v1 records, not a storage implementation or an authorization decision. */
const id = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/);
const instant = z.string().datetime({ offset: true });
const version = { schemaVersion: z.literal(1) };
const telegramId = z.string().regex(/^[1-9][0-9]*$/);
export const ownerSchema = z.strictObject({
  ...version, id, telegramUserId: telegramId, telegramPrivateChatId: telegramId
});
export const conversationSchema = z.strictObject({
  ...version, id, ownerId: id, channel: z.literal("telegram"), chatId: telegramId,
  harnessSessionId: id.optional()
});
export const connectionSchema = z.strictObject({
  ...version, id, ownerId: id, provider: z.literal("google-calendar"),
  accountId: z.string().min(1).max(320), credentialRef: id,
  scopes: z.array(z.string().min(1).max(256)).min(1).max(16),
  status: z.enum(["connected", "reauthorization-required", "revoked"])
});
export const automationSchema = z.strictObject({
  ...version, id, ownerId: id, conversationId: id, connectionId: id,
  kind: z.literal("daily-calendar-conflicts"), enabled: z.boolean(),
  calendarId: z.string().min(1).max(320),
  schedule: z.strictObject({
    kind: z.literal("daily"), localTime: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
    timeZone: z.string().max(100).refine(value => {
      try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
    }, "Expected a supported time zone"),
    missedRunPolicy: z.enum(["skip", "catch-up-today"])
  }),
  nextRunAt: instant
});
export const deliverySchema = z.strictObject({
  ...version, id, ownerId: id, conversationId: id, runId: id.optional(), occurrenceId: id.optional(),
  deduplicationKey: id, text: z.string().min(1).max(16000),
  status: z.enum(["pending", "sending", "sent", "failed", "uncertain", "cancelled", "expired"]),
  attempts: z.number().int().nonnegative(), createdAt: instant,
  expiresAt: instant.optional(),
  remoteMessageId: telegramId.optional()
}).refine(value => Boolean(value.runId) !== Boolean(value.occurrenceId), "Expected exactly one run or automation occurrence origin");
export type Owner = z.infer<typeof ownerSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Automation = z.infer<typeof automationSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
