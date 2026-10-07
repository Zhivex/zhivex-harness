import { limitNames, validateLimitSettings, type LimitName, type LimitSettings } from "./limit-settings.js";
export type LimitConsumption = { costUsd: number | null; tokens: number; steps: number; toolCalls: number; durationMinutes: number };
export type LimitNotice = { name: LimitName; action: "notify" | "stop"; threshold: number; actual: number; observedAt: number };
export type RunLimits = { runId: string; sessionId: string; origin: "task" | "project" | "default"; settings: LimitSettings;
  hostConfigDigest?: string;
  startedAt: number; status: string; consumption: LimitConsumption; notices: LimitNotice[]; cancellationRequested: boolean;
  reportedUsage: { inputTokens: number; outputTokens: number; complete: boolean; lastStep: number }; toolReceipts: string[]; pricing: LimitPricing | null; observationError?: boolean };
export type LimitPricing = { inputPerMillion: number; outputPerMillion: number; maxInputTokens?: number; source: string };
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
export function validateRunLimits(value: unknown): value is RunLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as RunLimits;
  return Object.keys(v).every(key => ["runId", "sessionId", "origin", "settings", "startedAt", "status", "consumption", "notices", "cancellationRequested", "reportedUsage", "toolReceipts", "pricing", "observationError", "hostConfigDigest"].includes(key)) &&
    (v.hostConfigDigest === undefined || typeof v.hostConfigDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(v.hostConfigDigest)) &&
    typeof v.runId === "string" && /^run_[A-Za-z0-9-]{1,80}$/.test(v.runId) && typeof v.sessionId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v.sessionId) &&
    ["task", "project", "default"].includes(v.origin) && validateLimitSettings(v.settings) && count(v.startedAt) &&
    ["created", "running", "waiting_approval", "completed", "failed", "cancelled", "timed_out", "interrupted", "cancel_requested"].includes(v.status) &&
    Boolean(v.consumption) && Object.keys(v.consumption).length === limitNames.length && limitNames.every(name => name === "costUsd" && v.consumption[name] === null || count(v.consumption[name])) &&
    typeof v.cancellationRequested === "boolean" && (v.observationError === undefined || typeof v.observationError === "boolean") &&
    Boolean(v.reportedUsage) && count(v.reportedUsage.inputTokens) && count(v.reportedUsage.outputTokens) && typeof v.reportedUsage.complete === "boolean" && count(v.reportedUsage.lastStep) &&
    Array.isArray(v.toolReceipts) && v.toolReceipts.every(id => typeof id === "string" && id.length <= 256) &&
    (v.pricing === null || Boolean(v.pricing) && count(v.pricing.inputPerMillion) && count(v.pricing.outputPerMillion) && typeof v.pricing.source === "string" && v.pricing.source.length <= 2048 &&
      (v.pricing.maxInputTokens === undefined || count(v.pricing.maxInputTokens))) &&
    Array.isArray(v.notices) && v.notices.length <= limitNames.length && v.notices.every(n => limitNames.includes(n.name) && ["notify", "stop"].includes(n.action) && count(n.threshold) && count(n.actual) && count(n.observedAt));
}

/** Observation is deliberately distinct from reservation or rollback. */
export function reachedLimits(run: RunLimits, now: number): LimitNotice[] {
  return limitNames.flatMap(name => {
    const threshold = run.settings[name];
    const actual = run.consumption[name];
    return threshold.value !== null && actual !== null && actual >= threshold.value && !run.notices.some(n => n.name === name)
      ? [{ name, action: threshold.action, threshold: threshold.value, actual, observedAt: now }] : [];
  });
}
