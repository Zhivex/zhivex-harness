import { createModelCatalog, type ModelCatalog as SdkModelCatalog, type ModelCatalogDatumEvidence, type ModelCatalogEntry } from "@zhivex-ai/core";
import type { ModelCatalog } from "./catalog.js";

/** Preserve the public harness manifest while using the SDK's shared evidence contract.
 * Per-million display rates become per-thousand SDK rates; absent facts stay absent.
 * This is an application-owned snapshot, never the frozen core default inventory.
 */
export function toSdkCompactionCatalog(catalog: ModelCatalog, inputTokens: number): SdkModelCatalog {
  const entries: ModelCatalogEntry[] = catalog.providers.flatMap(provider => provider.models.map(model => {
    const entry: ModelCatalogEntry = {provider: provider.id, modelId: model.id};
    const evidence: NonNullable<ModelCatalogEntry["evidence"]> = {};
    const source = (value: {sourceUrl: string; checkedAt: string}): ModelCatalogDatumEvidence => ({
      source: value.sourceUrl, sourceType: "primary", verifiedAt: value.checkedAt,
    });
    if (model.limits) {
      entry.contextWindowTokens = model.limits.contextWindowTokens;
      entry.contextWindowType = model.limits.contextWindowType;
      entry.maxOutputTokens = model.limits.maxOutputTokens;
      const proof = source(model.limits.evidence);
      evidence.contextWindowTokens = proof;
      evidence.contextWindowType = proof;
      evidence.maxOutputTokens = proof;
      if (model.limits.maxInputTokens !== undefined) {
        entry.maxInputTokens = model.limits.maxInputTokens;
        evidence.maxInputTokens = proof;
      }
    }
    // The v1 harness manifest has a rate ceiling rather than long-context multipliers.
    // Do not invent a tier or extrapolate when the requested input crosses it.
    if (model.pricing && (model.pricing.maxInputTokens === undefined || inputTokens <= model.pricing.maxInputTokens)) {
      entry.inputCostPer1kTokens = model.pricing.inputPerMillionTokens / 1000;
      entry.outputCostPer1kTokens = model.pricing.outputPerMillionTokens / 1000;
      evidence.inputCostPer1kTokens = source(model.pricing.evidence);
      evidence.outputCostPer1kTokens = source(model.pricing.evidence);
    }
    if (model.compaction?.suitability === "candidate" || model.compaction?.suitability === "evaluated") {
      // Legacy evaluated labels have no fixture/version/pass artifact. Never fabricate it.
      entry.compaction = {status: "candidate"};
    }
    entry.evidence = evidence;
    return entry;
  }));
  return createModelCatalog(entries, {
    snapshotVersion: catalog.revision,
    policy: {data: "rolling", updates: "catalog-replacement"},
    pricing: {version: catalog.revision, currency: "USD", unit: "per_1k_tokens"},
  });
}
