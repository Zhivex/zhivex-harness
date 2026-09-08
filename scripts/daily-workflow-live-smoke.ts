/** Opt-in installed-artifact acceptance: bounded real-provider coding tasks in disposable repositories. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPortableProcess } from "../src/process-runtime.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";

assert.equal(process.env.ZHIVEX_HARNESS_LIVE, "1", "Set ZHIVEX_HARNESS_LIVE=1 to authorize provider calls.");
const [artifactPath, reportPath] = process.argv.slice(2);
assert(artifactPath && path.isAbsolute(artifactPath), "Pass the installed dist/index.js absolute path.");
assert(reportPath && path.isAbsolute(reportPath), "Pass an absolute sanitized report path.");
const api: typeof import("../src/index.js") = await import(pathToFileURL(artifactPath).href);
const npm = await runPortableProcess(["npm", "--version"], { cwd: process.cwd() });
assert.equal(npm.exitCode, 0);
const scenarios = [
  {
    name: "fix-rounding-bug", files: {
      "src/money.js": "export function cents(amount) { return Math.floor(amount * 100); }\n",
      "test/money.test.js": "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {cents} from '../src/money.js'; test('round decimal currency',()=> { assert.equal(cents(1.005),101); assert.equal(cents(10.075),1008); assert.equal(cents(0),0); assert.equal(cents(1.23),123); });\n"
    }, editable: ["src/money.js"],
    task: "Fix decimal currency rounding in src/money.js for nonnegative amounts. Read the tests, reproduce the failure, repair the implementation, then run test. Do not change tests or package.json."
  },
  {
    name: "multi-file-cart-feature", files: {
      "src/pricing.js": "export function subtotal(items) { return items.reduce((sum,item)=>sum+item.unitCents*item.quantity,0); }\n",
      "src/index.js": "export {subtotal} from './pricing.js';\n",
      "test/pricing.test.js": "import {test} from 'node:test'; import assert from 'node:assert/strict'; import * as cart from '../src/index.js'; test('subtotal unchanged',()=>assert.equal(cart.subtotal([{unitCents:199,quantity:2}]),398)); test('discount',()=>{assert.equal(cart.total([{unitCents:199,quantity:2}],10),358);assert.equal(cart.total([],0),0);assert.equal(cart.total([{unitCents:100,quantity:1}],100),0);}); test('invalid discount',()=>{assert.throws(()=>cart.total([],101),RangeError);assert.throws(()=>cart.total([],-1),RangeError);});\n"
    }, editable: ["src/pricing.js", "src/index.js"],
    task: "Implement total(items, discountPercent=0) in src/pricing.js and export it from src/index.js. Preserve subtotal. Round the discounted subtotal to nearest integer cent. Reject discounts outside [0,100] with RangeError. Read the tests, reproduce the failure, implement both files, and run test. Do not change tests or package.json."
  }
];
const rows: Record<string, unknown>[] = [];
let failed = false;
for (const scenario of scenarios) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-live-daily-"));
  let harness: Awaited<ReturnType<typeof api.createHarness>> | undefined;
  const started = Date.now();
  let approvals = 0;
  let phase = "fixture";
  try {
    await mkdir(path.join(root, "src")); await mkdir(path.join(root, "test"));
    const originals = { ...scenario.files, "package.json": JSON.stringify({ name: "harness-daily-fixture", private: true,
      type: "module", packageManager: `npm@${npm.stdout.trim()}`, scripts: { test: "node --test" } }) };
    for (const [file, content] of Object.entries(originals)) await writeFile(path.join(root, file), content);
    const baseline = await runPortableProcess(["node", "--test"], { cwd: root });
    assert.notEqual(baseline.exitCode, 0, "The fixture must reproduce the initial defect.");
    harness = await api.createHarness({ provider: "openai", workspace: root, model: "gpt-5.6-luna",
      maxSteps: 12, timeoutMs: 150_000, maxInputTokens: 60_000, maxOutputTokens: 4096,
      maxTotalTokens: 64_096, allowedChecks: ["test"] });
    phase = "agent";
    const result = await api.runHarness(harness, { prompt: scenario.task }, {
      resolveApprovals: async (batch) => batch.map((approval) => {
        const args = JSON.parse(approval.arguments);
        const edit = ["apply_reviewed_edits", "apply_patch"].includes(approval.name) &&
          Array.isArray(args.changes) && args.changes.length > 0 && args.changes.every((change: {path: string; content: string}) =>
            scenario.editable.includes(change.path) && typeof change.content === "string" && change.content.length < 16_384);
        const check = approval.name === "run_check" && args.expectedScript === "node --test" && args.check === "test";
        assert(edit || check, "Provider requested an operation outside the acceptance fixture policy.");
        approvals++;
        return { provider: approval.provider, approvalRequestId: approval.id, approve: true, reason: "Bounded live acceptance fixture." };
      })
    });
    assert.equal(result.status, "completed");
    phase = "verification";
    const verification = await runPortableProcess(["node", "--test"], { cwd: root });
    assert.equal(verification.exitCode, 0, "Independent post-run tests must pass.");
    for (const [file, content] of Object.entries(originals)) {
      const actual = await readFile(path.join(root, file), "utf8");
      if (!scenario.editable.includes(file)) assert.equal(actual, content, "Read-only fixture drift");
      else assert.notEqual(actual, content, "Expected implementation file was not changed");
    }
    assert(result.toolResults.length, "Expected governed tool execution");
    rows.push({ task: scenario.name, status: "passed", initialTestsFailed: true, finalTestsPassed: true,
      editedFiles: scenario.editable.length, approvals, steps: result.steps.length, elapsedMs: Date.now() - started });
  } catch (error) {
    failed = true;
    rows.push({ task: scenario.name, status: "failed", approvals, elapsedMs: Date.now() - started,
      phase, errorType: error instanceof Error ? error.name : "Error", diagnostic: sanitizeOperationalError(error) });
    // No raw provider response, prompt, credential, or workspace path in shared output.
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
}
const report = { schemaVersion: 1, kind: "daily-workflow-acceptance", evidence: "local-installed-live",
  observedAt: new Date().toISOString(), version: api.HARNESS_VERSION,
  moduleSha256: createHash("sha256").update(await readFile(artifactPath)).digest("hex"),
  provider: "openai", model: "gpt-5.6-luna", status: failed ? "failed" : "passed", rows,
  limitations: ["Not protected release certification", "No public repository benchmark", "OpenAI only"] };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed) process.exitCode = 1;
