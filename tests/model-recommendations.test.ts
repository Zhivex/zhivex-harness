import { expect, test } from "bun:test";
import { bundledModelCatalog, catalogModelSchema, modelCatalogSchema, modelDescription } from "../src/models/catalog.js";
import { recommendCompactionModels } from "../src/models/compaction-recommendations.js";
import { toSdkCompactionCatalog } from "../src/models/sdk-catalog-adapter.js";

const request = {provider: "openai", inputTokens: 32_000, outputTokens: 2_000, now: Date.parse("2026-09-25T00:00:00Z")};
const fixture = () => structuredClone(bundledModelCatalog);
const luna = (catalog = bundledModelCatalog) => catalog.providers[0]!.models.find(m => m.id === "gpt-6-luna")!;

test("recommendations rank known costs and preserve catalog defaults and explicit choices", () => {
  const catalog = fixture();
  const before = JSON.stringify(catalog);
  const result = recommendCompactionModels(catalog, request);
  expect(result.recommendedModel).toBe("gpt-6-luna");
  expect(result.candidates[0]!.estimatedCostUsd).toBeCloseTo(0.0042);
  expect(result.candidates[0]!.warnings).toContain("compaction_quality_not_evaluated");
  expect(result.candidates[0]!.warnings).toContain("route_unverified");
  expect(JSON.stringify(catalog)).toBe(before);
  expect(recommendCompactionModels(catalog, {...request, availableModels: ["gpt-6-sol"]}).recommendedModel).toBe("gpt-6-sol");
});

test("combined window reserves output; independently published input limits do not", () => {
  const catalog = fixture();
  const m = luna(catalog);
  m.limits!.contextWindowTokens = 33_000;
  m.limits!.maxOutputTokens = 2_000;
  const result = recommendCompactionModels(catalog, request);
  expect(result.excluded.find(c => c.model.id === m.id)!.reasons).toContain("context_too_small");
  m.limits!.contextWindowType = "input";
  expect(recommendCompactionModels(catalog, request).recommendedModel).toBe(m.id);
  m.limits!.maxOutputTokens = 1000;
  expect(recommendCompactionModels(catalog, request).excluded.find(c => c.model.id === m.id)!.reasons).toContain("output_limit_too_small");
});

test("unknown and stale limits never become recommendations, custom IDs remain user choices", () => {
  const c = fixture();
  delete luna(c).limits;
  expect(recommendCompactionModels(c, {...request, availableModels: ["gpt-6-luna"]}).recommendedModel).toBeUndefined();
  expect(recommendCompactionModels(c, {...request, availableModels: ["custom-model"]}).recommendedModel).toBeUndefined();
  expect(recommendCompactionModels(c, {...request, now: Date.parse("2027-09-25T00:00:00Z")}).candidates).toEqual([]);
  expect(recommendCompactionModels(c, {...request, now: Date.parse("2025-09-25T00:00:00Z")}).candidates).toEqual([]);
  expect(recommendCompactionModels(c, {...request, provider: "meta"}).recommendedModel).toBeUndefined();
});

test("retired, unsuitable and unavailable models are excluded regardless of cost", () => {
  for (const mutate of [
    (m: ReturnType<typeof luna>) => { m.lifecycle = "retired"; },
    (m: ReturnType<typeof luna>) => { m.compaction!.suitability = "unsuitable"; },
    (m: ReturnType<typeof luna>) => { m.capabilities = []; },
  ]) {
    const c = fixture(); mutate(luna(c));
    expect(recommendCompactionModels(c, {...request, availableModels: ["gpt-6-luna"]}).candidates).toEqual([]);
  }
});

test("unknown, stale and out-of-tier pricing are reported without invented costs", () => {
  const c = fixture();
  const m = luna(c);
  for (const mutate of [
    () => { m.pricing!.maxInputTokens = 1000; },
    () => { m.pricing!.evidence.checkedAt = "2020-01-01"; },
    () => { delete m.pricing; },
  ]) {
    mutate();
    const candidate = recommendCompactionModels(c, {...request, availableModels: [m.id]}).candidates[0]!;
    expect(candidate.estimatedCostUsd).toBeUndefined();
    expect(candidate.warnings.some(w => w.startsWith("pricing_"))).toBe(true);
  }
});

test("metadata validates provenance, numeric bounds and remains backwards compatible", () => {
  const old = fixture();
  for (const p of old.providers) for (const m of p.models) { delete m.limits; delete m.pricing; delete m.compaction; }
  expect(modelCatalogSchema.safeParse(old).success).toBe(true);
  for (const mutate of [
    (m: ReturnType<typeof luna>) => { m.limits!.contextWindowTokens = -1; },
    (m: ReturnType<typeof luna>) => { m.limits!.evidence.sourceUrl = "javascript:alert(1)"; },
    (m: ReturnType<typeof luna>) => { m.limits!.evidence.sourceUrl = "https://user:secret@example.com"; },
    (m: ReturnType<typeof luna>) => { m.pricing!.inputPerMillionTokens = Infinity; },
  ]) {
    const m = structuredClone(luna()); mutate(m);
    expect(catalogModelSchema.safeParse(m).success).toBe(false);
  }
  expect(modelDescription(luna())).toContain("1,050,000");
  expect(modelDescription(old.providers[0]!.models[0]!)).toContain("Context: unknown");
});

test("invalid recommendation estimates reject before sorting", () => {
  for (const inputTokens of [NaN, Infinity, -1, 0, 1.5]) {
    expect(() => recommendCompactionModels(bundledModelCatalog, {...request, inputTokens})).toThrow("INVALID_COMPACTION_TOKEN_ESTIMATE");
  }
});

test("SDK adapter converts price units and carries per-datum evidence without filling unknown facts", () => {
  const sdk = toSdkCompactionCatalog(bundledModelCatalog, request.inputTokens);
  const entry = sdk.find("openai", "gpt-6-luna")!;
  expect(entry.inputCostPer1kTokens).toBe(0.0001);
  expect(entry.outputCostPer1kTokens).toBe(0.0005);
  expect(entry.evidence!.contextWindowTokens).toMatchObject({sourceType: "primary", verifiedAt: "2026-09-24"});
  expect(entry.compaction).toEqual({status: "candidate"});
  expect(sdk.find("meta", "muse-spark-1.3")!.contextWindowTokens).toBeUndefined();
  expect(toSdkCompactionCatalog(bundledModelCatalog, 300_000).find("openai", "gpt-6-luna")!.inputCostPer1kTokens).toBeUndefined();
});

test("legacy evaluated labels cannot fabricate SDK evaluation artifacts or rank as measured quality", () => {
  const c = fixture();
  const astra = c.providers[0]!.models.find(m => m.id === "gpt-6-astra")!;
  astra.compaction!.suitability = "evaluated";
  const result = recommendCompactionModels(c, request);
  expect(result.recommendedModel).toBe("gpt-6-luna");
  expect(result.candidates.find(candidate => candidate.model.id === astra.id)!.warnings).toContain("compaction_evaluation_evidence_missing");
});
