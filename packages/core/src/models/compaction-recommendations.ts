import { recommendAuxiliaryModel } from "@zhivex-ai/core";
import type { CatalogModel, ModelCatalog } from "./catalog.js";
import { toSdkCompactionCatalog } from "./sdk-catalog-adapter.js";

export interface CompactionRecommendationRequest {
  provider: string;
  /** Include instructions, wrappers and transcript in this estimate. */
  inputTokens: number;
  /** Reserve output, including reasoning tokens if the provider counts them here. */
  outputTokens: number;
  /** Only recommend within explicitly available model IDs when supplied. */
  availableModels?: readonly string[];
  /** Inject a clock for reproducible recommendations. */
  now?: number;
  maxEvidenceAgeDays?: number;
}
export interface CompactionModelAssessment {
  model: CatalogModel;
  eligible: boolean;
  reasons: string[];
  warnings: string[];
  estimatedCostUsd?: number;
}
export interface CompactionModelRecommendations {
  /** Advisory only: callers must preserve an explicit user model selection. */
  recommendedModel?: string;
  candidates: CompactionModelAssessment[];
  excluded: CompactionModelAssessment[];
}

/** Deterministic, same-provider advice; never loads credentials or selects a route. */
export function recommendCompactionModels(
  catalog: ModelCatalog,
  request: CompactionRecommendationRequest,
): CompactionModelRecommendations {
  for (const value of [request.inputTokens, request.outputTokens]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_COMPACTION_TOKEN_ESTIMATE");
  }
  const now = request.now ?? Date.now();
  const days = request.maxEvidenceAgeDays ?? 90;
  if (!Number.isFinite(now) || !Number.isFinite(days) || days < 0) throw new Error("INVALID_RECOMMENDATION_CLOCK");
  const fresh = (date: string) => {
    const age = now - Date.parse(`${date}T00:00:00Z`);
    return age >= 0 && age <= days * 86_400_000;
  };
  const models = catalog.providers.find(p => p.id === request.provider)?.models ?? [];
  const advice = recommendAuxiliaryModel({
    catalog: toSdkCompactionCatalog(catalog, request.inputTokens),
    routes: models.map(model => ({provider: request.provider, modelId: model.id,
      available: !request.availableModels || request.availableModels.includes(model.id),
      // This existing API is advisory; the console separately checks credential presence.
      // True is not an account-access assertion and no credential is resolved here.
      credentialsAvailable: true,
    })),
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    now: new Date(now).toISOString(),
    maxEvidenceAgeMs: days * 86_400_000,
  });
  const sdkCandidates = new Map(advice.candidates.map(candidate => [candidate.modelId, candidate]));
  const assessments = models.map(model => {
    const assessment = sdkCandidates.get(model.id)!;
    const reasons: string[] = [];
    const warnings: string[] = [];
    for (const exclusion of assessment.exclusions) {
      const mapped: Record<string, string> = {
        route_unavailable: "not_available",
        input_limit_exceeded: "input_limit_too_small",
        context_window_exceeded: "context_too_small",
        output_limit_exceeded: "output_limit_too_small",
        compaction_not_curated: model.compaction?.suitability === "unsuitable" ? "compaction_unsuitable" : "compaction_suitability_unknown",
      };
      reasons.push(mapped[exclusion] ?? (exclusion.endsWith("unknown_stale_or_conditional")
        ? model.limits ? "token_limits_stale" : "token_limits_unknown"
        : exclusion));
    }
    // Lifecycle, route validation and compaction curation remain harness-owned policy.
    if (model.lifecycle === "retired" || model.lifecycle === "deprecated") reasons.push(model.lifecycle);
    if (model.lifecycle === "unknown") warnings.push("lifecycle_unknown");
    if (model.validation !== "verified") warnings.push("route_unverified");
    if (!model.capabilities.includes("chat")) reasons.push("chat_capability_unknown");
    if (model.compaction && ["candidate", "evaluated"].includes(model.compaction.suitability)) {
      if (!fresh(model.compaction.evidence.checkedAt)) reasons.push("compaction_evidence_stale");
      warnings.push("compaction_quality_not_evaluated");
      if (model.compaction.suitability === "evaluated") warnings.push("compaction_evaluation_evidence_missing");
    }
    const pricing = model.pricing;
    if (!pricing) warnings.push("pricing_unknown");
    else if (!fresh(pricing.evidence.checkedAt)) warnings.push("pricing_stale");
    else if (pricing.maxInputTokens && request.inputTokens > pricing.maxInputTokens) warnings.push("pricing_tier_unknown");
    else if (assessment.estimatedCost === undefined) warnings.push("pricing_unknown");
    return {model, eligible: reasons.length === 0, reasons: [...new Set(reasons)], warnings,
      ...(assessment.estimatedCost === undefined ? {} : {estimatedCostUsd: assessment.estimatedCost})};
  });
  const candidates = assessments.filter(m => m.eligible).sort((a, b) => {
    if (a.estimatedCostUsd !== undefined && b.estimatedCostUsd !== undefined && a.estimatedCostUsd !== b.estimatedCostUsd) return a.estimatedCostUsd - b.estimatedCostUsd;
    if ((a.estimatedCostUsd === undefined) !== (b.estimatedCostUsd === undefined)) return a.estimatedCostUsd === undefined ? 1 : -1;
    return a.model.order - b.model.order || a.model.id.localeCompare(b.model.id);
  });
  return {
    ...(candidates[0] ? {recommendedModel: candidates[0].model.id} : {}),
    candidates,
    excluded: assessments.filter(m => !m.eligible),
  };
}
