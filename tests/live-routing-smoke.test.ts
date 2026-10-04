import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { runLiveRoutingSmoke, type RoutingSmokeDependencies } from "../scripts/live-routing-smoke.js";
import { routingFailure } from "../scripts/live-routing-diagnostics.js";
import { assertNoForbiddenDiagnosticContent, parseSanitizedOperationalError, restoreSanitizedOperationalError,
  sanitizeOperationalError, summarizeReleaseGates } from "../scripts/release-diagnostics.js";
import { HarnessProviderError } from "../src/runtime/errors.js";

const privateValue = "PRIVATE_PROMPT_KEY_PATH_MODEL_RUN_ID";
const env = { ZHIVEX_HARNESS_LIVE: "1", ZHIVEX_HARNESS_LIVE_PARENT_PROVIDER: "openai",
  ZHIVEX_HARNESS_LIVE_REVIEWER_PROVIDER: "vertex" };
const fixture = () => {
  const child = { runId: privateValue, toolCalls: 1, toolErrors: 0 };
  const state = { status: "completed", provider: "vertex", modelId: privateValue };
  const result = { status: "completed", outputText: privateValue,
    state: { provider: "openai", runId: privateValue, childRuns: [child] },
    toolResults: [{ toolName: "delegate_reviewer", isError: false }] };
  const close = mock(async () => {});
  const removeWorkspace = mock(async () => {});
  const load = mock(async () => state);
  const harness = { config: { scope: {} }, store: { load }, close };
  const run = mock(async () => result);
  const create = mock(async (_options: Parameters<RoutingSmokeDependencies["runtime"]["createHarness"]>[0]) => harness);
  const dependencies = {
    runtime: {
      parseProvider: (value: string) => value,
      providerDescriptor: () => ({ defaultModel: privateValue }),
      resolveHarnessModelRoutes: () => [], createHarnessRouteModels: () => ({}),
      createHarness: create, runHarness: run
    },
    provider: { assertLiveOptIn: mock(() => {}), requireCredentials: mock(() => {}), providerRunInput: () => ({ prompt: privateValue }) },
    orchestration: { orchestrationPrompt: () => privateValue, reviewDelegationContract: () => ({}), prepareReviewFixture: mock(async () => {}) },
    createWorkspace: mock(async () => `/private/${privateValue}`), removeWorkspace
  } as unknown as RoutingSmokeDependencies;
  return { dependencies, child, state, result, run, create, close, load, removeWorkspace };
};
const failed = async (f: ReturnType<typeof fixture>) => {
  try { await runLiveRoutingSmoke(env, async () => f.dependencies); }
  catch (error) {
    const diagnostic = sanitizeOperationalError(error);
    assertNoForbiddenDiagnosticContent(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain(privateValue);
    return diagnostic;
  }
  throw new Error("Expected routing gate to fail.");
};

describe("offline mixed routing certification diagnostics", () => {
  test("identifies an actual offline routed model mismatch previously reduced to a generic error", async () => {
    const f = fixture();
    const model = createMockLanguageModel({ provider: "openai", modelId: privateValue, streamEvents: [
      [{ type: "tool-call", toolCall: { id: "offline-delegation", name: "delegate_reviewer", input: { taskId: "release-review" } } },
        { type: "finish", finishReason: "tool-calls" }],
      [{ type: "text-delta", textDelta: "OFFLINE_PARENT_OK" }, { type: "finish", finishReason: "stop" }]
    ] });
    const reviewer = createMockLanguageModel({ provider: "vertex", modelId: "PRIVATE_DIFFERENT_MODEL",
      responses: [
        { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "offline-read", name: "read_file", input: { path: "review-target.txt" } } }] }], finishReason: "tool-calls" },
        { messages: [{ role: "assistant", parts: [{ type: "text", text: "OFFLINE_REVIEW_OK" }] }], text: "OFFLINE_REVIEW_OK", finishReason: "stop" }
      ] });
    f.dependencies.orchestration.prepareReviewFixture = workspace => writeFile(path.join(workspace, "review-target.txt"), "Offline baseline\n");
    f.dependencies.createWorkspace = () => mkdtemp(path.join(os.tmpdir(), "routing-real-loop-offline-"));
    f.dependencies.removeWorkspace = workspace => rm(workspace, { recursive: true, force: true });
    f.dependencies.orchestration.reviewDelegationContract = () => ({ taskId: "release-review", profile: "reviewer",
      prompt: "Offline fixture only.", allowedReadPaths: ["review-target.txt"], requiredOutput: "OFFLINE_REVIEW_OK" });
    f.dependencies.runtime.createHarness = options => createHarness({ ...options,
      modelInstance: model, subagentModels: { reviewer }, store: createInMemoryAgentRunStore()
    });
    let previousDiagnostic: ReturnType<typeof sanitizeOperationalError> | undefined;
    f.dependencies.runtime.runHarness = async (harness, input, options) => {
      const result = await runHarness(harness, input, options);
      expect(result.status).toBe("completed");
      const childState = await harness.store.load(result.state.childRuns![0]!.runId, harness.config.scope);
      expect(childState?.provider).toBe("vertex");
      // The previous gate exposed no identity for this exact assertion.
      try { assert.equal(childState?.modelId, privateValue); }
      catch (error) { previousDiagnostic = sanitizeOperationalError(error); }
      return result;
    };
    expect(await failed(f)).toMatchObject({ code: "EXECUTION_FAILED", category: "execution",
      routing: { assertion: "child_model" } });
    expect(previousDiagnostic).toMatchObject({ code: "EXECUTION_FAILED", category: "execution", retryable: false });
    expect(previousDiagnostic?.status).toBeUndefined();
  });

  test("retains the existing acceptance budgets and routing on success", async () => {
    const f = fixture();
    const stdout = mock((_chunk: string | Uint8Array) => true);
    const original = process.stdout.write;
    process.stdout.write = stdout;
    try { await runLiveRoutingSmoke(env, async () => f.dependencies); }
    finally { process.stdout.write = original; }
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ provider: "openai", model: privateValue,
      maxSteps: 4, maxToolCalls: 4, subagentMaxSteps: 2, subagentMaxToolCalls: 1, subagentProfiles: ["reviewer"] });
    expect(f.dependencies.provider.requireCredentials).toHaveBeenCalledWith(["openai", "vertex"], env);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.removeWorkspace).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]?.[0]).toContain('"ok": true');
  });

  test("preserves typed artifact errors emitted before the failed parent result", async () => {
    const f = fixture();
    // Deliberately not an instance of the driver's HarnessError: artifact class identity differs.
    const cause = Object.assign(new Error(privateValue), { code: "PROVIDER_UNAVAILABLE", category: "provider",
      retryable: true, cause: Object.assign(new Error(privateValue), { status: 429 }) });
    f.dependencies.runtime.runHarness = async (_harness, _input, options) => {
      await options?.onEvent?.({ type: "error", error: cause } as never);
      return { ...f.result, status: "failed", error: { message: privateValue } } as never;
    };
    const diagnostic = await failed(f);
    expect(diagnostic).toMatchObject({ code: "PROVIDER_UNAVAILABLE", category: "provider", retryable: true, status: 429,
      routing: { stage: "verification", assertion: "parent_completed", parentProvider: "openai", reviewerProvider: "vertex" } });
    expect(diagnostic.details?.chain.some(item => item.status === 429)).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  test("retains serialized typed errors without guessing from model output", async () => {
    const f = fixture();
    f.dependencies.runtime.runHarness = async () => ({ ...f.result, status: "failed",
      error: { message: privateValue, code: "APPROVAL_REQUIRED", category: "approval", retryable: false } }) as never;
    expect(await failed(f)).toMatchObject({ code: "APPROVAL_REQUIRED", category: "approval", retryable: false,
      routing: { assertion: "parent_completed" } });
    f.dependencies.runtime.runHarness = async () => ({ ...f.result, status: "failed", error: { message: privateValue } }) as never;
    expect(await failed(f)).toMatchObject({ code: "EXECUTION_FAILED", category: "execution", retryable: false });
  });

  test("keeps the first typed event when later events and rejection are generic", async () => {
    const f = fixture();
    f.dependencies.runtime.runHarness = async (_harness, _input, options) => {
      await options?.onEvent?.({ type: "error", error: new HarnessProviderError(privateValue, {
        cause: Object.assign(new Error(privateValue), { status: 503 })
      }) } as never);
      await options?.onEvent?.({ type: "error", error: new Error(privateValue) } as never);
      throw new Error(privateValue);
    };
    expect(await failed(f)).toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 503, routing: { stage: "parent_run" } });
  });

  for (const ending of ["returned", "rejected"] as const) {
    test(`keeps searching after a generic event for a ${ending} run`, async () => {
      const f = fixture();
      const typed = Object.assign(new Error(privateValue), { code: "PROVIDER_UNAVAILABLE", category: "provider",
        retryable: false, cause: Object.assign(new Error(privateValue), { status: 429 }) });
      f.dependencies.runtime.runHarness = async (_harness, _input, options) => {
        await options?.onEvent?.({ type: "error", error: new Error(privateValue) } as never);
        await options?.onEvent?.({ type: "error", error: typed } as never);
        await options?.onEvent?.({ type: "error", error: new HarnessProviderError(privateValue, {
          cause: Object.assign(new Error(privateValue), { status: 503 }), retryable: true
        }) } as never);
        if (ending === "rejected") throw new Error(privateValue);
        return { ...f.result, status: "failed", error: { message: privateValue } } as never;
      };
      expect(await failed(f)).toMatchObject({ code: "PROVIDER_UNAVAILABLE", category: "provider", retryable: false, status: 429,
        routing: { stage: ending === "returned" ? "verification" : "parent_run",
          ...(ending === "returned" ? { assertion: "parent_completed" } : {}) } });
    });
  }

  for (const ending of ["returned", "rejected"] as const) {
    test(`prefers a typed ${ending} error when every event is generic`, async () => {
      const f = fixture();
      const typed = Object.assign(new Error(privateValue), { code: "STATE_CONFLICT", category: "state", retryable: false });
      f.dependencies.runtime.runHarness = async (_harness, _input, options) => {
        await options?.onEvent?.({ type: "error", error: new Error(privateValue) } as never);
        if (ending === "rejected") throw typed;
        return { ...f.result, status: "failed", error: typed } as never;
      };
      expect(await failed(f)).toMatchObject({ code: "STATE_CONFLICT", category: "state", retryable: false });
    });
  }

  test("uses the first generic event only when no operational failure is recognized", async () => {
    const f = fixture();
    f.dependencies.runtime.runHarness = async (_harness, _input, options) => {
      await options?.onEvent?.({ type: "error", error: new TypeError(privateValue) } as never);
      await options?.onEvent?.({ type: "error", error: Object.assign(new Error(privateValue), {
        code: "PROVIDER_UNAVAILABLE", category: "provider", retryable: privateValue
      }) } as never);
      throw new Error(privateValue);
    };
    const diagnostic = await failed(f);
    expect(diagnostic).toMatchObject({ code: "EXECUTION_FAILED", category: "execution", retryable: false });
    expect(diagnostic.details?.chain.some(item => item.kind === "TypeError")).toBe(true);
  });

  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["parent_completed", f => { f.result.status = "cancelled"; }],
    ["parent_provider", f => { f.result.state.provider = privateValue; }],
    ["delegation_count", f => { f.result.toolResults = []; }],
    ["delegation_count", f => { f.result.toolResults.push(f.result.toolResults[0]!); }],
    ["delegation_success", f => { f.result.toolResults[0]!.isError = true; }],
    ["child_present", f => { f.result.state.childRuns = []; }],
    ["child_tool_budget", f => { f.child.toolCalls = 2; }],
    ["child_tool_errors", f => { f.child.toolErrors = 1; }],
    ["child_completed", f => { f.state.status = "waiting_approval"; }],
    ["child_provider", f => { f.state.provider = privateValue; }],
    ["child_model", f => { f.state.modelId = "PRIVATE_DIFFERENT_MODEL"; }]
  ];
  for (const [assertion, mutate] of cases) test(`fails closed at ${assertion}`, async () => {
    const f = fixture(); mutate(f);
    expect(await failed(f)).toMatchObject({ code: "EXECUTION_FAILED", routing: { stage: "verification", assertion } });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  for (const stage of ["fixture_prepare", "harness_create", "parent_run", "child_load", "harness_close", "workspace_cleanup"] as const) {
    test(`identifies ${stage} faults`, async () => {
      const f = fixture();
      const fault = async () => { throw Object.assign(new Error(privateValue), { code: "ECONNRESET" }); };
      if (stage === "fixture_prepare") f.dependencies.orchestration.prepareReviewFixture = fault;
      if (stage === "harness_create") f.dependencies.runtime.createHarness = fault;
      if (stage === "parent_run") f.dependencies.runtime.runHarness = fault;
      if (stage === "child_load") f.dependencies.runtime.createHarness = async () => ({ config: { scope: {} }, store: { load: fault }, close: f.close }) as never;
      if (stage === "harness_close") f.dependencies.runtime.createHarness = async () => ({ config: { scope: {} }, store: { load: f.load }, close: fault }) as never;
      if (stage === "workspace_cleanup") f.dependencies.removeWorkspace = fault;
      expect(await failed(f)).toMatchObject({ routing: { stage } });
    });
  }

  test("keeps the primary failure when both cleanup operations fail", async () => {
    const f = fixture(); f.result.toolResults = [];
    f.dependencies.runtime.createHarness = async () => ({ config: { scope: {} }, store: { load: f.load },
      close: async () => { throw new HarnessProviderError(privateValue); } }) as never;
    f.dependencies.removeWorkspace = async () => { throw Object.assign(new Error(privateValue), { status: 503 }); };
    const diagnostic = await failed(f);
    expect(diagnostic).toMatchObject({ code: "EXECUTION_FAILED", routing: { assertion: "delegation_count",
      cleanupFailures: [{ stage: "harness_close", code: "PROVIDER_UNAVAILABLE" }, { stage: "workspace_cleanup", status: 503 }] } });
    expect(sanitizeOperationalError(restoreSanitizedOperationalError(diagnostic))).toEqual(diagnostic);
  });

  test("rejects arbitrary diagnostic context and distinguishes safe assertion fingerprints", () => {
    const context = { stage: "verification", assertion: "child_model" } as const;
    const projection = sanitizeOperationalError(routingFailure(new Error(privateValue), context));
    expect(() => parseSanitizedOperationalError({ ...projection, routing: { ...context, model: privateValue } })).toThrow();
    expect(() => parseSanitizedOperationalError({ ...projection, routing: { ...context, assertion: privateValue } })).toThrow();
    expect(sanitizeOperationalError(Object.assign(new Error(privateValue), { routing: context })).routing).toBeUndefined();
    expect(projection.fingerprint).not.toBe(sanitizeOperationalError(routingFailure(new Error(privateValue), {
      stage: "verification", assertion: "delegation_count" })).fingerprint);
  });

  test("retains routing evidence through the child wrapper and source-bound summary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "routing-diag-offline-"));
    const f = fixture(); f.state.modelId = "PRIVATE_DIFFERENT_MODEL";
    const diagnostic = await failed(f);
    const binding = { releaseTag: "v1.4.0-rc.2", sourceCommit: "a".repeat(40), artifactSha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      workflowRunUrl: "https://github.com/Zhivex/zhivex-harness/actions/runs/123", workflowRunAttempt: 1 };
    try {
      const child = Bun.spawn([process.execPath, "scripts/run-release-gate.ts", "--gate", "routing-vertex", "--out", path.join(directory, "routing-vertex.json"), "--",
        process.execPath, "-e", `process.stderr.write(${JSON.stringify(JSON.stringify({ ok: false, gate: "live-routing-smoke", error: diagnostic }))});process.exit(1);`],
      { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, RELEASE_TAG: binding.releaseTag, SOURCE_COMMIT: binding.sourceCommit,
        ARTIFACT_SHA512: binding.artifactSha512, WORKFLOW_RUN_URL: binding.workflowRunUrl, WORKFLOW_RUN_ATTEMPT: "1" }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(1); expect(stderr).toBe("");
      expect(stdout).toBe("Release gate routing-vertex failed with 1 sanitized outcome(s).\n");
      const retained = JSON.parse(await readFile(path.join(directory, "routing-vertex.json"), "utf8"));
      expect(retained.outcomes[0].error).toEqual(diagnostic);
      const summary = await summarizeReleaseGates({ title: "Offline fault", diagnosticsDirectory: directory, expectedBinding: binding,
        gates: [{ name: "routing-vertex", outcome: "failure" }] });
      expect(summary.ok).toBe(false);
      expect(summary.rows[0]?.detail).toContain("stage=verification, assertion=child_model, route=openai->vertex");
      expect(JSON.stringify(retained) + JSON.stringify(summary)).not.toContain(privateValue);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("CLI artifact admission failures are sanitized before any provider operation", async () => {
    const child = Bun.spawn([process.execPath, "scripts/live-routing-smoke.ts"], {
      cwd: path.join(import.meta.dir, ".."), env: { ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT: "1" }, stdout: "pipe", stderr: "pipe"
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1); expect(stdout).toBe("");
    expect(JSON.parse(stderr).error.routing).toEqual({ stage: "runtime_load" });
    expect(stderr).not.toContain("AssertionError:");
  });

  test("CLI still rejects missing live opt-in and same-provider routes", async () => {
    const child = Bun.spawn([process.execPath, "scripts/live-routing-smoke.ts"], {
      cwd: path.join(import.meta.dir, ".."), env: {}, stdout: "pipe", stderr: "pipe"
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1); expect(stdout).toBe("");
    expect(JSON.parse(stderr).error.routing.stage).toBe("configuration");
    const f = fixture();
    const sameProvider = runLiveRoutingSmoke({ ...env, ZHIVEX_HARNESS_LIVE_REVIEWER_PROVIDER: "openai" }, async () => f.dependencies);
    await expect(sameProvider).rejects.toThrow("Live routing certification failed.");
    await sameProvider.catch(error => { expect(sanitizeOperationalError(error).routing?.assertion).toBe("distinct_providers"); });
    expect(f.dependencies.provider.requireCredentials).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
