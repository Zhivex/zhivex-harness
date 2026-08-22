import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAgentBudgetStatus } from "@zhivex-ai/agents";

import {
  PROVIDERS,
  providerDescriptor,
  type HarnessProvider
} from "../src/config.js";
import { createHarness, runHarness } from "../src/harness.js";
import { inspectHarnessRun } from "../src/operations.js";
import { runPortableProcess } from "../src/process-runtime.js";
import { liveProviderSmokeInternals } from "./live-provider-smoke.js";

const {
  assertLiveOptIn,
  errorEvidence,
  providerRunInput,
  requireCredentials,
  selectedProviders
} = liveProviderSmokeInternals;

const modelEnvironmentName = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`;

const childToken = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_${provider.toUpperCase()}_CHILD_OK`;

const parentToken = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_${provider.toUpperCase()}_ORCHESTRATION_OK`;

const childPrompt = (provider: HarnessProvider) =>
  `Review review-target.txt with at most one read-only repository tool. Do not mutate the workspace. Include this exact token in your final response: ${childToken(provider)}.`;

export const orchestrationPrompt = (provider: HarnessProvider) =>
  `Call delegate_reviewer exactly once with this exact JSON input: ${JSON.stringify({
    prompt: childPrompt(provider)
  })}.
Do not call any other tool. After the delegated result returns, reply exactly ${parentToken(provider)}.`;

const createLiveOrchestrationHarness = (args: {
  provider: HarnessProvider;
  model: string;
  workspace: string;
  stateDirectory: string;
}) => createHarness({
  provider: args.provider,
  model: args.model,
  workspace: args.workspace,
  stateDirectory: args.stateDirectory,
  maxSteps: 4,
  maxToolCalls: 4,
  subagentProfiles: ["reviewer"],
  subagentMaxSteps: 2,
  subagentMaxToolCalls: 1,
  env: process.env
});

export const prepareReviewFixture = async (workspace: string) => {
  const initialized = await runPortableProcess(["git", "init", "--quiet"], {
    cwd: workspace,
    timeoutMs: 10_000
  });
  assert.equal(initialized.exitCode, 0, initialized.stderr || initialized.stdout);
  const target = path.join(workspace, "review-target.txt");
  await writeFile(target, "baseline\n", "utf8");
  const staged = await runPortableProcess(["git", "add", "--", "review-target.txt"], {
    cwd: workspace,
    timeoutMs: 10_000
  });
  assert.equal(staged.exitCode, 0, staged.stderr || staged.stdout);
  await writeFile(target, "baseline\ncandidate change\n", "utf8");
};

const certifyProvider = async (
  provider: HarnessProvider,
  model: string,
  workspace: string,
  stateDirectory: string
) => {
  const first = await createLiveOrchestrationHarness({ provider, model, workspace, stateDirectory });
  let parentRunId = "";
  let childRunId = "";
  let childToolCalls = 0;
  let totalTokens = 0;
  try {
    const result = await runHarness(first, {
      ...providerRunInput(provider, orchestrationPrompt(provider)),
      scope: first.config.scope,
      idempotencyKey: `live-orchestration-${provider}`
    });
    assert.equal(result.status, "completed", result.outputText || result.error?.message);
    assert.ok(result.outputText.includes(parentToken(provider)), result.outputText);
    const delegations = result.toolResults.filter((entry) => entry.toolName === "delegate_reviewer");
    assert.equal(delegations.length, 1);
    assert.equal(delegations[0]?.isError, false);
    assert.equal(result.state.childRuns?.length, 1);
    const child = result.state.childRuns?.[0];
    assert.ok(child?.runId);
    assert.equal(child.status, "completed");
    assert.ok(child.outputText?.includes(childToken(provider)), child.outputText);
    assert.ok(child.toolCalls <= 1, "The reviewer exceeded its one-tool certification budget.");
    assert.equal(child.toolErrors, 0);
    childToolCalls = child.toolCalls;
    parentRunId = result.state.runId;
    childRunId = child.runId;
    totalTokens = getAgentBudgetStatus(result.state, first.config.budget, result).consumption.totalTokens;
    assert.ok(totalTokens > 0);
  } finally {
    await first.close();
  }

  const reopened = await createLiveOrchestrationHarness({ provider, model, workspace, stateDirectory });
  try {
    const [parent, child, inspection] = await Promise.all([
      reopened.store.load(parentRunId, reopened.config.scope),
      reopened.store.load(childRunId, reopened.config.scope),
      inspectHarnessRun(reopened.store, reopened.config, parentRunId)
    ]);
    assert.equal(parent?.status, "completed");
    assert.equal(child?.status, "completed");
    assert.equal(child?.parentRunId, parentRunId);
    assert.equal(inspection.hierarchy?.totalRuns, 2);
    assert.ok(JSON.stringify(inspection.hierarchy).includes(childRunId));
  } finally {
    await reopened.close();
  }

  return {
    ok: true as const,
    provider,
    model,
    parentRunId,
    childRunId,
    delegationExecutions: 1,
    childPersisted: true,
    processReopened: true,
    hierarchyRuns: 2,
    childToolCalls,
    aggregateTokens: totalTokens
  };
};

const run = async (env: NodeJS.ProcessEnv) => {
  assertLiveOptIn(env);
  const providers = selectedProviders(env);
  requireCredentials(providers, env);
  const evidence: Array<Record<string, unknown>> = [];

  for (const provider of providers) {
    const model = env[modelEnvironmentName(provider)]?.trim() || providerDescriptor(provider).defaultModel;
    const workspace = await mkdtemp(path.join(os.tmpdir(), `zhivex-harness-orchestration-${provider}-`));
    const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
    try {
      await prepareReviewFixture(workspace);
      evidence.push(await certifyProvider(provider, model, workspace, stateDirectory));
    } catch (error) {
      const failure = JSON.parse(errorEvidence(error, env)) as { error: Record<string, unknown> };
      evidence.push({ ok: false, provider, model, error: failure.error });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  const ok = evidence.every((entry) => entry.ok === true);
  process.stdout.write(`${JSON.stringify({
    ok,
    gate: "live-orchestration-smoke",
    certifiedAt: new Date().toISOString(),
    providers: evidence
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
};

export const liveOrchestrationSmokeInternals = {
  childPrompt,
  orchestrationPrompt,
  parentToken
};

if (import.meta.main) {
  run(process.env).catch((error: unknown) => {
    process.stderr.write(`${errorEvidence(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
