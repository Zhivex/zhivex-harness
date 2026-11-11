import { expect, test } from "bun:test";
import { automationSchema, connectionSchema, ownerSchema, deliverySchema } from "../src/contracts.js";

test("channel identity preserves large decimal IDs and excludes group chats", () => {
  expect(ownerSchema.parse({ schemaVersion: 1, id: "owner", telegramUserId: "9007199254740993",
    telegramPrivateChatId: "9007199254740993" }).telegramUserId).toBe("9007199254740993");
  expect(ownerSchema.safeParse({ schemaVersion: 1, id: "owner", telegramUserId: "123",
    telegramPrivateChatId: "-100123" }).success).toBe(false);
});

test("connection records reject inline credential fields and unknown schema versions", () => {
  const connection = { schemaVersion: 1, id: "c", ownerId: "o", provider: "google-calendar",
    accountId: "account", credentialRef: "credential:1", scopes: ["calendar.readonly"], status: "connected" };
  expect(connectionSchema.safeParse(connection).success).toBe(true);
  expect(connectionSchema.safeParse({ ...connection, accessToken: "secret" }).success).toBe(false);
  expect(connectionSchema.safeParse({ ...connection, schemaVersion: 2 }).success).toBe(false);
});

test("schedule rejects invalid local times and time zones", () => {
  const automation = { schemaVersion: 1, id: "a", ownerId: "o", conversationId: "c", connectionId: "g",
    kind: "daily-calendar-conflicts", enabled: true, calendarId: "primary",
    schedule: { kind: "daily", localTime: "08:30", timeZone: "America/Argentina/Buenos_Aires", missedRunPolicy: "skip" },
    nextRunAt: "2026-11-11T11:30:00Z" };
  expect(automationSchema.safeParse(automation).success).toBe(true);
  expect(automationSchema.safeParse({ ...automation, schedule: { ...automation.schedule, localTime: "25:00" } }).success).toBe(false);
  expect(automationSchema.safeParse({ ...automation, schedule: { ...automation.schedule, timeZone: "Unknown/Zone" } }).success).toBe(false);
});


test("scheduled deliveries have one occurrence origin and an explicit expiry", () => {
  const delivery = { schemaVersion: 1, id: "d", ownerId: "o", conversationId: "c", occurrenceId: "daily:2026-11-10",
    deduplicationKey: "daily:2026-11-10:0", text: "Agenda", status: "pending", attempts: 0,
    createdAt: "2026-11-10T08:00:00Z", expiresAt: "2026-11-11T00:00:00Z" };
  expect(deliverySchema.safeParse(delivery).success).toBe(true);
  expect(deliverySchema.safeParse({ ...delivery, runId: "run" }).success).toBe(false);
  expect(deliverySchema.safeParse({ ...delivery, occurrenceId: undefined }).success).toBe(false);
});
