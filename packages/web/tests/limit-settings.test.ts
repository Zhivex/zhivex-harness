import { expect, test } from "bun:test";
import { emptyLimitSettings, limitNames, parseLimitInput, validateLimitSettings } from "../src/limit-settings.js";
test("empty settings have no user thresholds and serialize losslessly", () => {
  const settings = emptyLimitSettings();
  expect(limitNames.every(name => settings[name].value === null)).toBe(true);
  expect(validateLimitSettings(JSON.parse(JSON.stringify(settings)))).toBe(true);
});
test("threshold schema rejects malformed values and unsupported fields/actions", () => {
  for (const value of [NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1, "5", {}, undefined]) {
    expect(validateLimitSettings({ ...emptyLimitSettings(), steps: { value, action: "notify" } })).toBe(false);
  }
  expect(validateLimitSettings({ ...emptyLimitSettings(), steps: { value: 1.5, action: "notify" } })).toBe(false);
  expect(validateLimitSettings({ ...emptyLimitSettings(), tokens: { value: 1, action: "noop" } })).toBe(false);
  expect(validateLimitSettings({ ...emptyLimitSettings(), sandbox: false })).toBe(false);
  expect(validateLimitSettings({ ...emptyLimitSettings(), costUsd: { value: 5.5, action: "stop" } })).toBe(true);
});
test("input parser supports decimal comma, empty fields and rejects ambiguous values", () => {
  expect(parseLimitInput("costUsd", "5,00")).toBe(5);
  expect(parseLimitInput("durationMinutes", "0.5")).toBe(.5);
  expect(parseLimitInput("steps", "  ")).toBeNull();
  for (const text of ["5,000,00", "1e3", "-1", "NaN", "Infinity", "0xFF", "1 000", "0"]) {
    expect(parseLimitInput("tokens", text)).toBeUndefined();
  }
  expect(parseLimitInput("steps", "1.5")).toBeUndefined();
});
