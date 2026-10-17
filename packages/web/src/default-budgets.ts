import { emptyLimitSettings, type LimitSettings } from "./limit-settings.js";

/**
 * Used when the person has not set thresholds. These match the engine ceilings
 * so read-only exploration stops instead of running without a cap.
 */
export const WEB_DEFAULT_STOP: LimitSettings = {
  ...emptyLimitSettings(),
  toolCalls: { value: 32, action: "stop" },
  tokens: { value: 120_000, action: "stop" },
  steps: { value: 50, action: "stop" },
  durationMinutes: { value: 15, action: "stop" },
};
