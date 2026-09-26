/** Opt-in installed-artifact acceptance: bounded real-provider coding tasks in disposable repositories. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPortableProcess } from "../src/execution/process-runtime.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";

assert.equal(process.env.ZHIVEX_HARNESS_LIVE, "1", "Set ZHIVEX_HARNESS_LIVE=1 to authorize provider calls.");
const [artifactPath, reportPath] = process.argv.slice(2);
assert(artifactPath && path.isAbsolute(artifactPath), "Pass the installed dist/index.js absolute path.");
assert(reportPath && path.isAbsolute(reportPath), "Pass an absolute sanitized report path.");
const api: typeof import("../src/index.js") = await import(pathToFileURL(artifactPath).href);
const bun = await runPortableProcess(["bun", "--version"], { cwd: process.cwd() });
assert.equal(bun.exitCode, 0);
const models = { meta: "muse-spark-1.3", qwen: "qwen3.8-max", openai: "gpt-6-luna" } as const;
const budgetMode = process.env.ZHIVEX_HARNESS_LIVE_DAILY_BUDGET ?? "bounded-baseline";
assert(["bounded-baseline", "runtime-token-defaults", "runtime-defaults"].includes(budgetMode), "Unknown daily-workflow budget mode.");
const runtimeDefaults = api.resolveHarnessConfig({ workspace: process.cwd() });
const defaults = runtimeDefaults.budget;
const tokenLimits = budgetMode !== "bounded-baseline"
  ? { maxInputTokens: defaults.maxInputTokens, maxOutputTokens: defaults.maxOutputTokens, maxTotalTokens: defaults.maxTotalTokens }
  : { maxInputTokens: 60_000, maxOutputTokens: 4096, maxTotalTokens: 64_096 };
assert(!defaults.unlimitedTokens && tokenLimits.maxTotalTokens <= 250_000, "Live acceptance requires bounded token budgets.");
const limits = { maxSteps: budgetMode === "runtime-defaults" ? runtimeDefaults.maxSteps : 12,
  timeoutMs: budgetMode === "runtime-defaults" ? runtimeDefaults.timeoutMs : 150_000, ...tokenLimits };
const providers = (process.env.ZHIVEX_HARNESS_LIVE_PROVIDERS ?? "meta,qwen,openai").split(",").map(value => value.trim());
assert(providers.length > 0 && new Set(providers).size === providers.length &&
  providers.every(provider => Object.hasOwn(models, provider)), "Select meta, qwen, and/or openai without duplicates.");
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
const selectedTask = process.env.ZHIVEX_HARNESS_LIVE_DAILY_TASK;
assert(!selectedTask || scenarios.some(scenario => scenario.name === selectedTask), "Unknown daily-workflow task.");
for (const selected of providers) for (const scenario of scenarios.filter(scenario => !selectedTask || scenario.name === selectedTask)) {
  const provider = selected as keyof typeof models;
  const model = process.env[`ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`] ?? models[provider];
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-live-daily-"));
  let harness: Awaited<ReturnType<typeof api.createHarness>> | undefined;
  const started = Date.now();
  let approvals = 0;
  let phase = "fixture";
  let phaseStarted = started;
  const phaseTimingsMs: Record<string, number> = {};
  const stepTimings: { step: number; status: string; durationMs?: number; firstEventMs?: number }[] = [];
  let activeStep: { step: number; started: number; firstEventMs?: number } | undefined;
  const transition = (next: string) => {
    phaseTimingsMs[phase] = (phaseTimingsMs[phase] ?? 0) + Date.now() - phaseStarted;
    phase = next; phaseStarted = Date.now();
  };
  const timings = () => ({ phaseTimingsMs: { ...phaseTimingsMs, [phase]: (phaseTimingsMs[phase] ?? 0) + Date.now() - phaseStarted },
    stepTimings, ...(activeStep ? { unfinishedStep: { step: activeStep.step,
      elapsedMs: Date.now() - activeStep.started, firstEventMs: activeStep.firstEventMs } } : {}) });
  let runEvidence: Record<string, unknown> = {};
  let protectedFiles: Record<string, string> = {};
  try {
    await mkdir(path.join(root, "src")); await mkdir(path.join(root, "test"));
    const originals = { ...scenario.files, "package.json": JSON.stringify({ name: "harness-daily-fixture", private: true,
      type: "module", packageManager: `bun@${bun.stdout.trim()}`, scripts: { test: "bun test" } }) };
    protectedFiles = Object.fromEntries(Object.entries(originals).filter(([file]) => !scenario.editable.includes(file)));
    for (const [file, content] of Object.entries(originals)) await writeFile(path.join(root, file), content);
    const baseline = await runPortableProcess(["bun", "test"], { cwd: root });
    assert.notEqual(baseline.exitCode, 0, "The fixture must reproduce the initial defect.");
    harness = await api.createHarness({ provider, workspace: root, model,
      ...limits, allowedChecks: ["test"], requireVerifiedDelivery: false });
    runEvidence = { requireVerifiedDelivery: harness.config.requireVerifiedDelivery,
      effectiveBudget: harness.config.budget };
    transition("agent");
    const result = await api.runHarness(harness, { prompt: scenario.task,
      ...(provider === "openai" || provider === "qwen" ? { providerOptions: { apiMode: "responses" } } : {}) }, {
      onEvent: event => {
        if (event.type === "agent-step-start") activeStep = { step: event.stepIndex, started: Date.now() };
        if (activeStep && activeStep.firstEventMs === undefined && ["text-delta", "reasoning-delta", "tool-call"].includes(event.type)) {
          activeStep.firstEventMs = Date.now() - activeStep.started;
        }
        if (event.type === "agent-step-finish") {
          stepTimings.push({ step: event.step.index, status: event.step.status,
            ...(activeStep?.firstEventMs === undefined ? {} : { firstEventMs: activeStep.firstEventMs }),
            ...(typeof event.step.startedAt === "number" && typeof event.step.finishedAt === "number"
              ? { durationMs: event.step.finishedAt - event.step.startedAt } : {}) });
          activeStep = undefined;
        }
        if (event.type === "agent-run-finish") runEvidence = { ...runEvidence, runStatus: event.status,
          steps: event.state.steps.length, usage: event.state.usage,
          ...(event.state.error ? { runDiagnostic: sanitizeOperationalError(event.state.error) } : {}) };
      },
      resolveApprovals: async (batch) => batch.map((approval) => {
        const args = JSON.parse(approval.arguments);
        const edit = ["apply_reviewed_edits", "apply_patch"].includes(approval.name) &&
          Array.isArray(args.changes) && args.changes.length > 0 && args.changes.every((change: {path: string; content: string}) =>
            scenario.editable.includes(change.path) && typeof change.content === "string" && change.content.length < 16_384);
        const replacement = approval.name === "apply_reviewed_replacement" && scenario.editable.includes(args.path) &&
          typeof args.newText === "string" && args.newText.length < 16_384;
        const check = approval.name === "run_check" && args.expectedScript === "bun test" && args.check === "test";
        assert(edit || replacement || check, "Provider requested an operation outside the acceptance fixture policy.");
        approvals++;
        return { provider: approval.provider, approvalRequestId: approval.id, approve: true, reason: "Bounded live acceptance fixture." };
      })
    });
    runEvidence = { ...runEvidence, runStatus: result.status, steps: result.steps.length, usage: result.usage,
      childUsage: result.state.childRuns?.map(child => ({ status: child.status, usage: child.usage })),
      toolCalls: result.toolResults.length,
      toolErrors: result.toolResults.filter(tool => tool.isError).length,
      tools: result.toolResults.map(tool => ({ name: tool.toolName, isError: tool.isError,
        ...(tool.toolName === "run_check" && tool.output && typeof tool.output === "object" && !Array.isArray(tool.output)
          ? { exitCode: (tool.output as Record<string, unknown>).exitCode } : {}) })),
      ...(result.error ? { runDiagnostic: sanitizeOperationalError(result.error) } : {}) };
    assert.equal(result.status, "completed");
    transition("verification");
    const verification = await runPortableProcess(["bun", "test"], { cwd: root });
    assert.equal(verification.exitCode, 0, "Independent post-run tests must pass.");
    for (const [file, content] of Object.entries(originals)) {
      const actual = await readFile(path.join(root, file), "utf8");
      if (!scenario.editable.includes(file)) assert.equal(actual, content, "Read-only fixture drift");
      else assert.notEqual(actual, content, "Expected implementation file was not changed");
    }
    assert(result.toolResults.length, "Expected governed tool execution");
    rows.push({ provider, model, task: scenario.name, status: "passed", initialTestsFailed: true, finalTestsPassed: true,
      editedFiles: scenario.editable.length, approvals, steps: result.steps.length, elapsedMs: Date.now() - started,
      ...runEvidence, ...timings() });
  } catch (error) {
    failed = true;
    const failurePhase = phase;
    if (phase !== "fixture") {
      transition("failure-verification");
      const independent = await runPortableProcess(["bun", "test"], { cwd: root });
      let protectedFilesUnchanged = true;
      for (const [file, content] of Object.entries(protectedFiles)) {
        if (await readFile(path.join(root, file), "utf8").catch(() => null) !== content) protectedFilesUnchanged = false;
      }
      runEvidence = { ...runEvidence, independentTestsPassed: independent.exitCode === 0, protectedFilesUnchanged };
    }
    rows.push({ provider, model, task: scenario.name, status: "failed", approvals, elapsedMs: Date.now() - started,
      phase: failurePhase, ...runEvidence, ...timings(), errorType: error instanceof Error ? error.name : "Error", diagnostic: sanitizeOperationalError(error) });
    // No raw provider response, prompt, credential, or workspace path in shared output.
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
}
const report = { schemaVersion: 1, kind: "daily-workflow-acceptance", evidence: "local-installed-live",
  observedAt: new Date().toISOString(), version: api.HARNESS_VERSION,
  moduleSha256: createHash("sha256").update(await readFile(artifactPath)).digest("hex"),
  providers, tasks: scenarios.filter(scenario => !selectedTask || scenario.name === selectedTask).map(scenario => scenario.name),
  budgetMode, limits,
  status: failed ? "failed" : "passed", rows,
  limitations: ["Not protected release certification", "No public repository benchmark", "Small disposable coding fixtures; selected tasks recorded explicitly"] };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed) process.exitCode = 1;
