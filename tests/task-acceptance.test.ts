import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { StreamEvent, JsonValue } from "@zhivex-ai/core";
import { pathToFileURL } from "node:url";
const engine: typeof import("../src/engine/index.js") = process.env.ZHIVEX_ACCEPTANCE_ENGINE
  ? await import(pathToFileURL(process.env.ZHIVEX_ACCEPTANCE_ENGINE).href)
  : await import("../src/engine/index.js");
import { ACCEPTANCE_FIXTURES } from "../scripts/acceptance/fixtures.js";
import { runAcceptanceCase, summarizeAcceptance } from "../scripts/acceptance/runner.js";

const fixedMoney = "export function cents(amount) { return Math.round(Number(amount + 'e2')); }\n";
const correctedMoney = "export function cents(amount) { return Math.sign(amount) * Math.round(Number(Math.abs(amount) + 'e2')); }\n";
const route = { provider: "openai", model: "fixture", route: "deterministic" };
function modelFor(fixture: typeof ACCEPTANCE_FIXTURES[number], bad = false) {
  let id = 0;
  const tool = (name: string, input: JsonValue): StreamEvent[] => [{ type: "tool-call", toolCall: { id: `accept-${++id}`, name, input } }, { type: "finish", finishReason: "tool-calls" }];
  const done: StreamEvent[] = [{ type: "text-delta", textDelta: "Completed" }, { type: "finish", finishReason: "stop" }];
  const events: StreamEvent[][] = [tool("run_check", { check: "test", expectedScript: "bun verify.mjs" })];
  for (const file of fixture.editable) {
    const oldText = fixture.files[file]!;
    const newText = file.endsWith("index.js") ? "export {subtotal,total} from './pricing.js';\n" : file.endsWith("pricing.js") ? oldText + "export function total(items,discountPercent=0) { if(discountPercent<0||discountPercent>100) throw new RangeError(); return Math.round(subtotal(items)*(1-discountPercent/100)); }\n" : bad ? "export const cents = () => 1;\n" : fixedMoney;
    events.push(tool("apply_reviewed_replacement", { path: file, expectedDigest: `sha256:${createHash("sha256").update(oldText).digest("hex")}`, oldText, newText }));
  }
  events.push(tool("run_check", { check: "test", expectedScript: "bun verify.mjs" }), done);
  if (fixture.mode === "correction") {
    const oldText = fixedMoney;
    events.push(tool("apply_reviewed_replacement", { path: "src/money.js", expectedDigest: `sha256:${createHash("sha256").update(oldText).digest("hex")}`, oldText, newText: correctedMoney }), done);
  }
  return createMockLanguageModel({ provider: "openai", modelId: "fixture", streamEvents: events });
}
for (const fixture of ACCEPTANCE_FIXTURES) test(`common acceptance exercises ${fixture.id} through the engine`, async () => {
  const row = await runAcceptanceCase(engine, fixture, route, 1, modelFor(fixture));
  expect(row, JSON.stringify(row)).toMatchObject({ status: "passed", initialTestsFailed: true, independentTestsPassed: true, protectedFilesUnchanged: true });
}, 30_000);

test("files and model completion cannot replace independent acceptance; retries preserve failure", async () => {
  const fixture = ACCEPTANCE_FIXTURES[0]!;
  const failed = await runAcceptanceCase(engine, fixture, route, 1, modelFor(fixture, true));
  expect(failed.status).toBe("failed");
  const recovered = await runAcceptanceCase(engine, fixture, route, 2, modelFor(fixture));
  expect(recovered.status).toBe("passed");
  expect(summarizeAcceptance([failed, recovered], 1)).toMatchObject({ status: "failed", firstAttemptPassed: 0, recovered: 1, failedAttempts: 1 });
  expect(summarizeAcceptance([], 7).status).toBe("failed");
  expect(summarizeAcceptance([recovered], 1).status).toBe("failed");
}, 30_000);
