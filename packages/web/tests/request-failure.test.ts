import { expect, test } from "bun:test";
import { ModelSelectionRejectedError, modelSelectionRejection } from "../src/request-failure.js";

test("only host-confirmed model admission rejections leave the client actionable", () => {
  for (const code of ["WEB_MODEL_CHANGE_BUSY", "WEB_MODEL_CHANGE_IN_PROGRESS", "WEB_MODEL_NOT_CONFIGURED", "WEB_CREDENTIALS_REQUIRED"]) {
    const rejected = modelSelectionRejection("action", { action: "selectModel" }, 400, { ok: false, error: { code } });
    expect(rejected).toBeInstanceOf(ModelSelectionRejectedError);
    expect(rejected?.message).toBe(code);
  }
});

test("transport, rollback, malformed and later-context failures remain uncertain", () => {
  const fault = { ok: false, error: { code: "WEB_MODEL_CHANGE_BUSY" } };
  for (const [route, value, status, document] of [
    ["context", {}, 400, fault],
    ["action", { action: "start" }, 400, fault],
    ["action", { action: "selectModel" }, 200, fault],
    ["action", { action: "selectModel" }, 500, fault],
    ["action", { action: "selectModel" }, 400, { error: fault.error }],
    ["action", { action: "selectModel" }, 400, { ok: false, error: { code: "WEB_MODEL_SWITCH_FAILED" } }],
    ["action", { action: "selectModel" }, 400, { ok: false, error: { code: "WEB_MODEL_UNAVAILABLE" } }],
    ["action", { action: "selectModel" }, 400, { ok: false, error: { code: "WEB_REQUEST_FAILED" } }],
  ] as const) expect(modelSelectionRejection(route, value, status, document)).toBeUndefined();
});
