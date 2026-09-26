import { captureCandidate, captureRunCandidate } from "./candidate.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import type { AgentRunOutput, AgentRunState, AgentStep, ToolSet } from "@zhivex-ai/agents";
import { createHarness, runHarness, renderHarnessInstructions, type HarnessRunDiagnostics } from "../../src/runtime/harness.js";
import type { HarnessExecutionSession } from "../../src/execution/execution-environment.js";
import { selectAndInstrumentTools } from "../time-to-safe-fix-efficiency.js";
import { wrapLanguageModel } from "@zhivex-ai/core";
import { createCatalogObserver } from "./model-catalog.js";
import { observeVerifierFailures, type VerifierFailureObserver } from "./verifier-observer.js";
import { pythonSourceProbe } from "./python-environment.js";

import { projectState, sanitizeOperationalError } from "./telemetry.js";

export const SWE_BENCH_VERIFICATION_INSTRUCTIONS = "\nSWE-bench evaluation: source is in /workspace. Discover the project's documented test runner and confirm its dependencies are available before committing to a verifier. Do not assume pytest is installed. Use the existing project runner or a self-contained assertion with available dependencies; do not install new dependencies. The independent evaluator runs after you finish. Do not alter tests or project configuration. Inspect the patch, then use verify_and_apply_environment_patch with a focused verifier that asserts the reported behavior and related variants. Successful verification is required for import. No hidden evaluator tests are available.";

export const requestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runToken: z.string().regex(/^[a-f0-9]{32}$/),
  workspace: z.string().min(1),
  instanceId: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  problem: z.string().min(1).max(200_000),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  model: z.string().min(1),
  provider: z.enum(["openai", "qwen"]).default("openai"),
  limits: z.strictObject({
    steps: z.number().int().min(1).max(100),
    outputPerTurn: z.number().int().min(256).max(16384),
    inputTokens: z.number().int().min(1000).max(1_000_000),
    outputTokens: z.number().int().min(256).max(100_000),
    timeoutSeconds: z.number().int().min(10).max(3600),
    memoryMb: z.number().int().min(512).max(8192),
    cpus: z.number().int().min(1).max(8)
  })
});

export async function runDriver(raw: unknown, preflight = false, onVerifierFailure?: VerifierFailureObserver) {
  const input = requestSchema.parse(raw);
  let diagnostics: HarnessRunDiagnostics | undefined;
  let candidate: Awaited<ReturnType<typeof captureCandidate>> | undefined;
  let candidateCaptureFailure: ReturnType<typeof sanitizeOperationalError> | undefined;
  const managedState = process.env.ZHIVEX_SWEBENCH_STATE_DIRECTORY;
  const state = managedState ?? await mkdtemp(path.join(os.tmpdir(), "zhivex-swebench-state-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let output: AgentRunOutput | undefined;
  let lastState: AgentRunState | undefined;
  const observed = new Map<number, AgentStep>();
  const guardrails: { stage: string; budgetLimit: string | null }[] = [];
  let thrownDiagnostic: ReturnType<typeof sanitizeOperationalError> | null = null;
  let approvals = 0;
  const started = performance.now();
  const stageTimings: { event: string; elapsedMs: number }[] = [];
  const stages = new Set<string>();
  const stage = (event: string) => { if (!stages.has(event)) { stages.add(event); stageTimings.push({ event, elapsedMs: performance.now() - started }); } };
  let phase = "setup";
  let failure: string | null = null;
  const names = ["read_task", "repair_plan", "mutation_audit", "list_files", "read_files", "search_files", "search_many", "apply_reviewed_replacement", "apply_reviewed_edits", "run_environment_shell",
    "run_environment_command", "inspect_environment_patch", "verify_and_apply_environment_patch"];
  let measured: ReturnType<typeof selectAndInstrumentTools> | undefined;
  const catalog = createCatalogObserver(names);
  try {
    harness = await createHarness({
      workspace: input.workspace, stateDirectory: state, provider: input.provider, model: input.model,
      store: createInMemoryAgentRunStore(), projectContext: false, requireVerifiedDelivery: true,
      onTelemetryEvent: (event) => {
        if (event.type === "guardrail-triggered") {
          const limit = event.metadata?.budgetLimit;
          guardrails.push({ stage: event.stage, budgetLimit: typeof limit === "string" &&
            ["maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxSteps", "maxToolCalls", "maxToolErrors"].includes(limit) ? limit : null });
        }
      },
      executionBackend: "oci", ociImage: input.image, ociShellMode: "ask",
      ociAllowedCommands: ["python", "python3", "bash", "sh", "git", "npm"],
      ociMaxMemoryMb: input.limits.memoryMb, ociMaxCpus: input.limits.cpus, ociMaxPids: 256,
      ociMaxWorkspaceBytes: 256 * 1024 * 1024, ociMaxFileWriteBytes: 4 * 1024 * 1024,
      ociTmpfsMb: 256, ociMaxProcessRuntimeMs: 60_000, ociMaxProcessOutputBytes: 20_000,
      maxSteps: input.limits.steps, maxToolCalls: input.limits.steps * 8, maxToolErrors: 12,
      maxInputTokens: input.limits.inputTokens, maxOutputTokens: input.limits.outputTokens,
      maxTotalTokens: input.limits.inputTokens + input.limits.outputTokens,
      compactionMaxMessages: 16, compactionMaxEstimatedInputTokens: 10000, compactionKeepRecentMessages: 2,
      timeoutMs: input.limits.timeoutSeconds * 1000, subagentProfiles: [], env: process.env
    });
    measured = selectAndInstrumentTools(harness.agent.tools as ToolSet, names);
    harness.agent.tools = observeVerifierFailures(measured.tools, onVerifierFailure);
    harness.agent.model = wrapLanguageModel(harness.agent.model, [catalog.middleware]);
    harness.agent.instructions = renderHarnessInstructions(names);
    harness.agent.instructions += "\nRepair progress policy: after 70% of either cumulative token budget is used, repository-wide discovery pauses. Reserve the remaining budget for focused reads, reproduction, repair, checks and verified import. Unchanged results from a third identical read/search are omitted. Adjust scope when instructed; never skip verification to fit the budget.";
    harness.agent.instructions += SWE_BENCH_VERIFICATION_INSTRUCTIONS;
    if (preflight) {
      phase = "preflight";
      const session = await harness.executionEnvironment!.acquire({ runId: `swebench-${input.runToken}`, scope: harness.config.scope });
      try {
        if ((session as Partial<HarnessExecutionSession>).kind !== "zhivex-oci") throw new Error("Unexpected execution backend");
        const result = await (session as HarnessExecutionSession).runCommand("python", ["-c", pythonSourceProbe()]);
        if (result.exitCode !== 0) throw new Error("Python checkout import binding preflight failed");
      } finally { await session.release?.({ status: "completed" }); }
    } else {
    phase = "agent";
    output = await runHarness(harness, {
      runId: `swebench-${input.runToken}`, prompt: `Implement a repair for the following issue in the repository. Use tools to inspect and change files, run focused checks, then inspect and import the environment patch. Do not stop at a proposal. Prefer a small exact replacement; do not rewrite a large file.\n\n${input.problem}`, maxSteps: input.limits.steps, maxTokens: input.limits.outputPerTurn,
      toolExecution: { parallel: false, stopOnError: false, validationErrorMode: "tool-result" },
      reasoning: { effort: input.provider === "qwen" ? "none" : "low" }, providerOptions: input.provider === "qwen" ? { apiMode: "chat", enable_thinking: false } : { apiMode: "responses", store: false }, maxRetries: 0,
      timeoutMs: input.limits.timeoutSeconds * 1000
    }, { onDiagnostics: value => { diagnostics = value; }, terminalReceiptTools: ["verify_and_apply_environment_patch"], maxTerminalVerificationRetries: 2, onEvent: (event) => {
      if (event.type === "tool-call") {
        if (event.toolCall.name.startsWith("verify_and_apply")) stage("verification-requested");
        if (["apply_reviewed_edits", "apply_reviewed_replacement"].includes(event.toolCall.name)) stage("edit-requested");
        if (event.toolCall.name.startsWith("run_environment")) stage("command-requested");
      }
      if (event.type === "agent-step-finish") {
        observed.set(event.step.index, event.step);
        for (const tool of event.step.toolResults) {
          if (!tool.isError && ["apply_reviewed_edits", "apply_reviewed_replacement"].includes(tool.toolName)) stage("governed-edit-completed");
        }
      }
      if (event.type === "agent-run-finish") lastState = event.state;
    }, resolveApprovals: async (pending) => pending.map((approval) => {
      approvals++;
      return { provider: approval.provider, approvalRequestId: approval.id,
        approve: names.includes(approval.name), reason: "Benchmark operator approves isolated repair; official grading is independent." };
    }) });
    if (output.status === "completed" && output.toolResults.some(result => !result.isError && result.toolName.startsWith("verify_and_apply"))) stage("verified-import-completed");
    }
  } catch (error) {
    thrownDiagnostic = sanitizeOperationalError(error);
    failure = typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code).replace(/[^A-Z0-9_]/g, "").slice(0, 64) : "DRIVER_ERROR";
  } finally {
    if (harness && !lastState) lastState = await Promise.resolve(harness.store.load(`swebench-${input.runToken}`, harness.config.scope)).catch(() => undefined) ?? undefined;
    if (harness?.executionEnvironment && !preflight && lastState) {
      try {
        candidate = await captureRunCandidate(harness.executionEnvironment, lastState);
      } catch (error) { candidateCaptureFailure = sanitizeOperationalError(error); }
    }
    await harness?.close().catch(error => { thrownDiagnostic ??= sanitizeOperationalError(error); failure ??= "CLEANUP_FAILED"; });
    if (!managedState) await rm(state, { recursive: true, force: true }).catch(error => { thrownDiagnostic ??= sanitizeOperationalError(error); failure ??= "CLEANUP_FAILED"; });
  }
  const telemetry = projectState(output?.state ?? lastState, observed);
  const modelBudget = diagnostics?.budget ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, modelCalls: 0, usageComplete: false, stopReason: null };
  return {
    candidateSnapshot: candidate ?? null, candidateCaptureFailure: candidateCaptureFailure ?? null,
    modelTimings: diagnostics?.modelTimings ?? [],
    modelCatalog: catalog.snapshot(),
    stageTimings,
    approvalTimings: diagnostics?.approvalTimings ?? [],
    toolTimings: [...(measured?.timings.entries() ?? [])].map(([name, timing]) => ({ name, ...timing })),
    schemaVersion: 1, candidate: "zhivex", instanceId: input.instanceId,
    status: failure ? "failed" : preflight ? "preflight-passed" : output?.status ?? "failed", failure: modelBudget.stopReason ?? failure ?? (output?.status === "failed" ? (guardrails.some(g => g.budgetLimit) ? "BUDGET_EXHAUSTED" : "AGENT_FAILED") : null), phase,
    durationMs: performance.now() - started, approvals, ...telemetry,
    inputTokens: modelBudget.inputTokens, outputTokens: modelBudget.outputTokens,
    cachedInputTokens: modelBudget.cachedInputTokens, modelCalls: modelBudget.modelCalls,
    usageComplete: preflight || modelBudget.usageComplete,
    thrownDiagnostic, guardrails,
    repairProgress: diagnostics?.progress ?? null,
    contextMetrics: diagnostics?.contextMetrics ?? [],
    omittedContextMeasurements: Math.max(0, modelBudget.modelCalls - (diagnostics?.contextMetrics?.length ?? 0)),
    toolCalls: [...(measured?.timings.values() ?? [])].reduce((sum, tool) => sum + tool.calls, 0)
  };
}
if (import.meta.main) {
  const bytes = await Bun.stdin.text();
  if (bytes.length > 256_000) throw new Error("Driver request too large.");
  process.stdout.write(JSON.stringify(await runDriver(JSON.parse(bytes), process.argv.includes("--preflight"))) + "\n");
}
