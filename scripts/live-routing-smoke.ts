import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseProvider,
  providerDescriptor,
  type HarnessProvider
} from "../src/config.js";
import { createHarness, runHarness } from "../src/harness.js";
import { createHarnessRouteModels, resolveHarnessModelRoutes } from "../src/routing.js";
import { orchestrationPrompt, prepareReviewFixture } from "./live-orchestration-smoke.js";
import { liveProviderSmokeInternals } from "./live-provider-smoke.js";

const {
  assertLiveOptIn,
  errorEvidence,
  providerRunInput,
  requireCredentials
} = liveProviderSmokeInternals;

const providerFrom = (env: NodeJS.ProcessEnv, name: string, fallback: string): HarnessProvider =>
  parseProvider(env[name]?.trim() || fallback);

export const LIVE_ROUTING_DEFAULTS = {
  parent: "openai",
  reviewer: "qwen"
} as const;

const modelFrom = (env: NodeJS.ProcessEnv, provider: HarnessProvider) =>
  env[`ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`]?.trim() ||
  providerDescriptor(provider).defaultModel;

const run = async (env: NodeJS.ProcessEnv) => {
  assertLiveOptIn(env);
  const parentProvider = providerFrom(env, "ZHIVEX_HARNESS_LIVE_PARENT_PROVIDER", LIVE_ROUTING_DEFAULTS.parent);
  const reviewerProvider = providerFrom(env, "ZHIVEX_HARNESS_LIVE_REVIEWER_PROVIDER", LIVE_ROUTING_DEFAULTS.reviewer);
  if (parentProvider === reviewerProvider) {
    throw new Error("Live routing certification requires distinct parent and reviewer providers.");
  }
  requireCredentials([parentProvider, reviewerProvider], env);
  const parentModel = modelFrom(env, parentProvider);
  const reviewerModel = modelFrom(env, reviewerProvider);
  const routes = resolveHarnessModelRoutes([
    `reviewer=${reviewerProvider}:${reviewerModel}`
  ]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-live-routing-"));
  const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
  try {
    await prepareReviewFixture(workspace);
    const harness = await createHarness({
      provider: parentProvider,
      model: parentModel,
      workspace,
      stateDirectory,
      maxSteps: 4,
      maxToolCalls: 4,
      subagentProfiles: ["reviewer"],
      subagentMaxSteps: 2,
      subagentMaxToolCalls: 1,
      subagentModels: createHarnessRouteModels(routes, env),
      env
    });
    try {
      const result = await runHarness(harness, {
        ...providerRunInput(parentProvider, orchestrationPrompt(parentProvider)),
        scope: harness.config.scope,
        idempotencyKey: `live-routing-${parentProvider}-${reviewerProvider}`
      });
      assert.equal(result.status, "completed", result.outputText || result.error?.message);
      assert.equal(result.state.provider, parentProvider);
      const delegations = result.toolResults.filter((entry) => entry.toolName === "delegate_reviewer");
      assert.equal(delegations.length, 1);
      assert.equal(delegations[0]?.isError, false);
      const child = result.state.childRuns?.[0];
      assert.ok(child?.runId);
      assert.ok(child.toolCalls <= 1, "The routed reviewer exceeded its one-tool certification budget.");
      assert.equal(child.toolErrors, 0);
      const childState = await harness.store.load(child.runId, harness.config.scope);
      assert.equal(childState?.status, "completed");
      assert.equal(childState?.provider, reviewerProvider);
      assert.equal(childState?.modelId, reviewerModel);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        gate: "live-routing-smoke",
        parent: { provider: parentProvider, model: parentModel, runId: result.state.runId },
        reviewer: { provider: reviewerProvider, model: reviewerModel, runId: child.runId },
        delegationExecutions: 1,
        childToolCalls: child.toolCalls
      }, null, 2)}\n`);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  run(process.env).catch((error: unknown) => {
    process.stderr.write(`${errorEvidence(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
