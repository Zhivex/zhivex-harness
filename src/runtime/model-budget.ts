import type { LanguageModelMiddleware, ModelGenerateInput, TokenUsage } from "@zhivex-ai/core";
import { ProviderToolCallError } from "@zhivex-ai/core/provider";
import { z } from "zod";
import { inspectRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { measureContext } from "../context/context-metrics.js";

export const MODEL_BUDGET_KEY = "zhivexTransportBudget";
const savedBudget = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(),
  usageComplete: z.boolean(), inFlight: z.boolean().default(false) });

/** Conservative prediction, not a provider tokenizer or a billing guarantee. */
export const estimateRequestTokens = (input: ModelGenerateInput) => {
  const measured = measureContext(input);
  if (measured.unmeasuredToolDefinitions) throw new Error("CONTEXT_ESTIMATE_UNAVAILABLE");
  const characters = measured.systemCharacters + measured.userCharacters + measured.assistantCharacters +
    measured.toolResultCharacters + measured.otherMessageCharacters + measured.toolDefinitionCharacters;
  return Math.ceil(characters / 3) + 64;
};

export const workBudgetReached = (input: ModelGenerateInput,
  stats: { inputTokens: number; outputTokens: number; reservedInputTokens: number; reservedOutputTokens: number },
  limits: { inputTokens: number; outputTokens: number }) =>
  stats.inputTokens + estimateRequestTokens(input) > limits.inputTokens - stats.reservedInputTokens ||
  stats.outputTokens >= limits.outputTokens - stats.reservedOutputTokens;

/** Per logical run; snapshots are attached to every durable SDK checkpoint. */
export const createModelBudget = (limits: { inputTokens: number; outputTokens: number }, options: {
  saved?: unknown; diagnostics?: unknown; closure?: () => boolean; reserveFraction?: number;
} = {}) => {
  const restored = options.saved === undefined ? undefined : savedBudget.parse(options.saved);
  const reserve = options.reserveFraction ?? 0.3;
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= 1) throw new Error("Invalid closure reserve.");
  const prior = inspectRuntimeDiagnostics(options.diagnostics);
  const contextMetrics: ReturnType<typeof measureContext>[] = prior?.contextMeasurements ?? [];
  let omittedContextMeasurements = prior?.omittedContextMeasurements ?? 0;
  const stats = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, modelCalls: 0,
    usageComplete: true, inFlight: false, ...restored,
    stopReason: null as string | null, reservedInputTokens: Math.ceil(limits.inputTokens * reserve),
    reservedOutputTokens: Math.ceil(limits.outputTokens * reserve), predictedInputTokens: 0, outputCapApplied: false };
  if (restored?.inFlight) stats.usageComplete = false;
  const modelTimings: { durationMs: number; firstTokenMs: number | null; completed: boolean }[] = prior?.modelTimings ?? [];
  const snapshot = () => ({ inputTokens: stats.inputTokens, outputTokens: stats.outputTokens,
    cachedInputTokens: stats.cachedInputTokens, modelCalls: stats.modelCalls,
    usageComplete: stats.usageComplete, inFlight: stats.inFlight });
  const before = (input: ModelGenerateInput, provider: string) => {
    input.abortSignal?.throwIfAborted();
    stats.predictedInputTokens = estimateRequestTokens(input);
    const closure = options.closure?.() ?? false;
    const inputCeiling = limits.inputTokens - (closure ? 0 : stats.reservedInputTokens);
    const outputCeiling = limits.outputTokens - (closure ? 0 : stats.reservedOutputTokens);
    stats.stopReason = !stats.usageComplete ? "USAGE_UNAVAILABLE" :
      stats.inputTokens + stats.predictedInputTokens > inputCeiling ? (closure ? "INPUT_TOKEN_BUDGET" : "WORK_TOKEN_BUDGET") :
      stats.outputTokens >= outputCeiling ? (closure ? "OUTPUT_TOKEN_BUDGET" : "WORK_TOKEN_BUDGET") : null;
    if (stats.stopReason) throw new Error(stats.stopReason);
    // Preserve the selected API route: Qwen Responses rejects maxTokens, and
    // adding it in auto mode silently switches to Chat Completions.
    const capSupported = provider !== "qwen" || input.providerOptions?.apiMode === "chat" ||
      (input.providerOptions?.apiMode !== "responses" && (input.maxTokens !== undefined || input.reasoning?.budgetTokens !== undefined));
    stats.outputCapApplied = capSupported;
    if (capSupported) input.maxTokens = Math.max(1, Math.min(input.maxTokens ?? 2048, outputCeiling - stats.outputTokens));
    stats.modelCalls++; stats.inFlight = true;
    if (contextMetrics.length < 128) contextMetrics.push(measureContext(input)); else omittedContextMeasurements++;
  };
  const record = (usage: TokenUsage | undefined) => {
    stats.inFlight = false;
    if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined ||
      ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0].every(v => Number.isSafeInteger(v) && v >= 0)) {
      stats.usageComplete = false; return;
    }
    stats.inputTokens += usage.inputTokens; stats.outputTokens += usage.outputTokens;
    stats.cachedInputTokens += usage.cachedInputTokens ?? 0;
  };
  const recordFailure = (error: unknown, provider: string) => {
    // Older adapters have no terminal usage on this error. Never infer it from
    // messages or accept an arbitrary thrown object's accounting. The optional
    // property is consumed structurally until the typed SDK update is published.
    const usage: unknown = error instanceof ProviderToolCallError && error.provider === provider
      ? Reflect.get(error, "usage") : undefined;
    record(usage && typeof usage === "object" ? usage as TokenUsage : undefined);
  };
  const middleware: LanguageModelMiddleware = {
    name: "harness-transport-budget-v2",
    async wrapGenerate(context, next) {
      before(context.input, context.model.provider); const started = performance.now(); let completed = false;
      try { const result = await next(); record(result.usage); completed = true; return result; }
      catch (error) { recordFailure(error, context.model.provider); throw error; }
      finally { if (modelTimings.length < 128) modelTimings.push({ durationMs: performance.now() - started, firstTokenMs: null, completed }); }
    },
    async wrapStream(context, next) {
      before(context.input, context.model.provider); const started = performance.now(); let firstTokenMs: number | null = null;
      try {
        const stream = await next();
        return (async function* () {
          let finished = false, failureAccounted = false;
          try { for await (const event of stream) {
            if (firstTokenMs === null && (event.type === "text-delta" || event.type === "tool-call")) firstTokenMs = performance.now() - started;
            if (event.type === "finish" && !finished) { record(event.usage); finished = true; }
            yield event;
          } } catch (error) {
            if (!finished) { recordFailure(error, context.model.provider); failureAccounted = true; }
            throw error;
          } finally { if (!finished && !failureAccounted) stats.usageComplete = false; stats.inFlight = false;
            if (modelTimings.length < 128) modelTimings.push({ durationMs: performance.now() - started, firstTokenMs, completed: finished }); }
        })();
      } catch (error) { recordFailure(error, context.model.provider);
        if (modelTimings.length < 128) modelTimings.push({ durationMs: performance.now() - started, firstTokenMs, completed: false });
        throw error; }
    }
  };
  return { stats, middleware, snapshot, contextMetrics, modelTimings, get omittedContextMeasurements() { return omittedContextMeasurements; } };
};
