export const limitNames = ["costUsd", "tokens", "steps", "toolCalls", "durationMinutes"] as const;
export type LimitName = typeof limitNames[number];
export type LimitThreshold = { value: number | null; action: "notify" | "stop" };
export type LimitSettings = Record<LimitName, LimitThreshold>;
export type LimitScope = "task" | "project";
export const emptyLimitSettings = (): LimitSettings => Object.fromEntries(
  limitNames.map(name => [name, { value: null, action: "notify" }]),
) as LimitSettings;

/** Browser and host share the same canonical representation; null means no user threshold. */
export function validateLimitSettings(value: unknown): value is LimitSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== limitNames.length) return false;
  return limitNames.every(name => {
    const threshold = record[name];
    if (!threshold || typeof threshold !== "object" || Array.isArray(threshold)) return false;
    const { value: amount, action, ...rest } = threshold as Record<string, unknown>;
    if (Object.keys(rest).length || (action !== "notify" && action !== "stop")) return false;
    return amount === null || (typeof amount === "number" && Number.isFinite(amount) && amount > 0 &&
      amount <= Number.MAX_SAFE_INTEGER &&
      (["costUsd", "durationMinutes"].includes(name) || Number.isSafeInteger(amount)));
  });
}

export function parseLimitInput(name: LimitName, text: string): number | null | undefined {
  if (!text.trim()) return null;
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const amount = Number(normalized);
  return validateLimitSettings({ ...emptyLimitSettings(), [name]: { value: amount, action: "notify" } })
    ? amount : undefined;
}
