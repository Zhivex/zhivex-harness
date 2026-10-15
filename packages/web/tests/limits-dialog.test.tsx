import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LimitsDialog } from "../src/LimitsDialog.js";
import { counted, limitsReadError, limitsSaveError } from "../src/limit-copy.js";
import { emptyLimitSettings } from "../src/limit-settings.js";

const initial = { task: emptyLimitSettings(), project: emptyLimitSettings() };

test("the limits dialog is English and uses singular step copy", () => {
  const html = renderToStaticMarkup(<LimitsDialog initial={initial} onCancel={() => {}} onSave={() => {}} technicalNotice="Host policy stays in place." />);
  expect(html).toContain("Configure only what you need");
  expect(html).toContain("Save limits");
  expect(html).toContain("Notify");
  expect(html).toContain("Stop");
  expect(html).not.toMatch(/Límites|pasos|Avisar|Detener|Guardar/);
});

test("one reported step stays singular", () => {
  expect(counted(1, "step")).toBe("1 step");
  expect(counted(2, "tool call")).toBe("2 tool calls");
  expect(counted(1, "token")).toBe("1 token");
});

test("limits load and save failures stay English inside the dialog", () => {
  expect(limitsReadError).toBe("Limits could not be read. Reconnect to look them up again.");
  expect(limitsSaveError).toBe("The change was not confirmed. Close and reopen to look up the limits before saving again.");
  for (const error of [limitsReadError, limitsSaveError]) {
    const html = renderToStaticMarkup(<LimitsDialog initial={initial} onCancel={() => {}} onSave={() => {}} technicalNotice="Host policy stays in place." error={error} />);
    expect(html).toContain(error);
    expect(html).not.toMatch(/Límites|límites|pasos|Avisar|Detener|Guardar|No se /);
  }
});
