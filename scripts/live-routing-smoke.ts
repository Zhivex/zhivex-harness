import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sanitizeOperationalError } from "./release-diagnostics.js";
import { attachRoutingDiagnostic, createRoutingErrorCollector, routingDiagnosticFor, routingFailure, routingProviderSchema, type RoutingDiagnostic } from "./live-routing-diagnostics.js";
import type { loadLiveSmokeRuntime } from "./live-smoke-runtime.js";
import type { liveProviderSmokeInternals } from "./live-provider-smoke.js";
import type * as orchestration from "./live-orchestration-smoke.js";

export const LIVE_ROUTING_DEFAULTS = { parent: "openai", reviewer: "qwen" } as const;

type Runtime = Pick<Awaited<ReturnType<typeof loadLiveSmokeRuntime>>,
  "parseProvider" | "providerDescriptor" | "createHarness" | "runHarness" | "createHarnessRouteModels" | "resolveHarnessModelRoutes">;
export interface RoutingSmokeDependencies {
  runtime: Runtime;
  provider: Pick<typeof liveProviderSmokeInternals, "assertLiveOptIn" | "providerRunInput" | "requireCredentials">;
  orchestration: {
    orchestrationPrompt: typeof orchestration.orchestrationPrompt;
    prepareReviewFixture: typeof orchestration.prepareReviewFixture;
    reviewDelegationContract: typeof orchestration.reviewDelegationContract;
  };
  createWorkspace(): Promise<string>;
  removeWorkspace(workspace: string): Promise<void>;
}

const loadDependencies = async (env: NodeJS.ProcessEnv): Promise<RoutingSmokeDependencies> => {
  // Keep artifact validation and helper loading inside the sanitized failure boundary.
  const { loadLiveSmokeRuntime } = await import("./live-smoke-runtime.js");
  const runtime = await loadLiveSmokeRuntime(env);
  const { liveProviderSmokeInternals } = await import("./live-provider-smoke.js");
  const orchestration = await import("./live-orchestration-smoke.js");
  return {
    runtime, provider: liveProviderSmokeInternals, orchestration,
    createWorkspace: () => mkdtemp(path.join(os.tmpdir(), "zhivex-harness-live-routing-")),
    removeWorkspace: (workspace) => rm(workspace, { recursive: true, force: true })
  };
};

/** Injectable operations support offline faults; the CLI always uses the artifact-checked loader. */
export const runLiveRoutingSmoke = async (
  env: NodeJS.ProcessEnv,
  load: (env: NodeJS.ProcessEnv) => Promise<RoutingSmokeDependencies> = loadDependencies
) => {
  let context: RoutingDiagnostic = { stage: "runtime_load" };
  let dependencies: RoutingSmokeDependencies | undefined;
  let workspace: string | undefined;
  let harness: Awaited<ReturnType<Runtime["createHarness"]>> | undefined;
  let failure: Error | undefined;
  let evidence: unknown;
  const assertion = (name: NonNullable<RoutingDiagnostic["assertion"]>) => {
    context = { ...context, stage: "verification", assertion: name };
  };
  const stage = (name: RoutingDiagnostic["stage"]) => {
    const { assertion: _assertion, ...rest } = context;
    context = { ...rest, stage: name };
  };
  try {
    dependencies = await load(env);
    const { runtime, provider, orchestration } = dependencies;
    stage("configuration");
    provider.assertLiveOptIn(env);
    const parentProvider = runtime.parseProvider(env.ZHIVEX_HARNESS_LIVE_PARENT_PROVIDER?.trim() || LIVE_ROUTING_DEFAULTS.parent);
    const reviewerProvider = runtime.parseProvider(env.ZHIVEX_HARNESS_LIVE_REVIEWER_PROVIDER?.trim() || LIVE_ROUTING_DEFAULTS.reviewer);
    // Only the built-in finite provider identities are diagnostic evidence.
    const parentIdentity = routingProviderSchema.safeParse(parentProvider);
    const reviewerIdentity = routingProviderSchema.safeParse(reviewerProvider);
    context = { ...context, ...(parentIdentity.success ? { parentProvider: parentIdentity.data } : {}),
      ...(reviewerIdentity.success ? { reviewerProvider: reviewerIdentity.data } : {}) };
    context.assertion = "distinct_providers";
    assert.notEqual(parentProvider, reviewerProvider, "Live routing certification requires distinct parent and reviewer providers.");
    stage("configuration");
    provider.requireCredentials([parentProvider, reviewerProvider], env);
    const modelFrom = (provider: typeof parentProvider) =>
      env[`ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`]?.trim() || runtime.providerDescriptor(provider).defaultModel;
    const parentModel = modelFrom(parentProvider);
    const reviewerModel = modelFrom(reviewerProvider);
    const routes = runtime.resolveHarnessModelRoutes([`reviewer=${reviewerProvider}:${reviewerModel}`]);
    stage("workspace_create");
    workspace = await dependencies.createWorkspace();
    stage("fixture_prepare");
    await orchestration.prepareReviewFixture(workspace);
    stage("harness_create");
    harness = await runtime.createHarness({
      provider: parentProvider, model: parentModel, workspace,
      stateDirectory: path.join(workspace, ".zhivex-harness", "runs"),
      maxSteps: 4, maxToolCalls: 4,
      subagentProfiles: ["reviewer"],
      delegationContracts: [orchestration.reviewDelegationContract(parentProvider)],
      subagentMaxSteps: 2, subagentMaxToolCalls: 1,
      subagentModels: runtime.createHarnessRouteModels(routes, env), env
    });
    stage("parent_run");
    const errors = createRoutingErrorCollector();
    const result = await runtime.runHarness(harness, {
      ...provider.providerRunInput(parentProvider, orchestration.orchestrationPrompt(parentProvider)),
      scope: harness.config.scope, idempotencyKey: `live-routing-${parentProvider}-${reviewerProvider}`
    }, { onEvent: (event) => {
      if (event.type === "error") errors.observe(event.error);
    } }).catch((error: unknown) => { throw errors.select(error); });
    assertion("parent_completed");
    if (result.status !== "completed") {
      const terminalError = errors.select(result.error);
      if (terminalError !== undefined) throw terminalError;
    }
    assert.equal(result.status, "completed", "Unexpected parent run status.");
    assertion("parent_provider");
    assert.equal(result.state.provider, parentProvider);
    const delegations = result.toolResults.filter((entry) => entry.toolName === "delegate_reviewer");
    assertion("delegation_count");
    assert.equal(delegations.length, 1);
    assertion("delegation_success");
    assert.equal(delegations[0]?.isError, false);
    const child = result.state.childRuns?.[0];
    assertion("child_present");
    assert.ok(child?.runId);
    assertion("child_tool_budget");
    assert.ok(child.toolCalls <= 1, "The routed reviewer exceeded its one-tool certification budget.");
    assertion("child_tool_errors");
    assert.equal(child.toolErrors, 0);
    stage("child_load");
    const childState = await harness.store.load(child.runId, harness.config.scope);
    assertion("child_completed");
    assert.equal(childState?.status, "completed");
    assertion("child_provider");
    assert.equal(childState?.provider, reviewerProvider);
    assertion("child_model");
    assert.equal(childState?.modelId, reviewerModel);
    evidence = {
      ok: true, gate: "live-routing-smoke",
      parent: { provider: parentProvider, model: parentModel, runId: result.state.runId },
      reviewer: { provider: reviewerProvider, model: reviewerModel, runId: child.runId },
      delegationExecutions: 1, childToolCalls: child.toolCalls
    };
  } catch (error) {
    failure = routingFailure(error, context);
  }
  const cleanupFailures: NonNullable<RoutingDiagnostic["cleanupFailures"]> = [];
  const cleanup = async (name: "harness_close" | "workspace_cleanup", operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) {
      stage(name);
      if (!failure) failure = routingFailure(error, context);
      else {
        const projection = sanitizeOperationalError(routingFailure(error, context));
        cleanupFailures.push({ stage: name, code: projection.code, category: projection.category,
          retryable: projection.retryable, ...(projection.status === undefined ? {} : { status: projection.status }) });
      }
    }
  };
  if (harness) await cleanup("harness_close", () => harness!.close());
  if (workspace && dependencies) await cleanup("workspace_cleanup", () => dependencies!.removeWorkspace(workspace!));
  if (failure) {
    if (cleanupFailures.length) {
      attachRoutingDiagnostic(failure, { ...routingDiagnosticFor(failure)!, cleanupFailures });
    }
    throw failure;
  }
  try { process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`); }
  catch (error) { stage("evidence_write"); throw routingFailure(error, context); }
};

if (import.meta.main) {
  runLiveRoutingSmoke(process.env).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ ok: false, gate: "live-routing-smoke", error: sanitizeOperationalError(error) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
