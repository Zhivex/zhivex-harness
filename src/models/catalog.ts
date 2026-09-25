import { z } from "zod";
import bundled from "./catalog.json";

const modelId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const text = z.string().min(1).max(300).regex(/^[^\x00-\x1f\x7f-\x9f]*$/);
const evidence = z.object({
  sourceUrl: z.url().max(1000).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Evidence requires an HTTPS URL without credentials"),
  checkedAt: z.iso.date(),
}).strict();
const tokenLimit = z.number().int().positive().max(1_000_000_000);
const price = z.number().finite().nonnegative().max(1_000_000);
export const catalogModelSchema = z.object({
  id: modelId,
  name: text,
  group: z.enum(["primary", "other"]),
  order: z.number().int().min(0),
  lifecycle: z.enum(["active", "deprecated", "retired", "unknown"]),
  validation: z.enum(["verified", "unverified"]),
  capabilities: z.array(z.enum(["chat", "tools", "vision"])).max(3),
  reason: text.optional(),
  replacement: modelId.optional(),
  retirementDate: z.iso.date().optional(),
  limits: z.object({
    contextWindowTokens: tokenLimit,
    // Some providers publish a separate input limit instead of a shared window.
    contextWindowType: z.enum(["combined", "input"]),
    maxOutputTokens: tokenLimit,
    maxInputTokens: tokenLimit.optional(),
    evidence,
  }).strict().optional(),
  pricing: z.object({
    currency: z.literal("USD"),
    inputPerMillionTokens: price,
    outputPerMillionTokens: price,
    cachedInputPerMillionTokens: price.optional(),
    // A single rate must not be extrapolated to a provider's higher context tier.
    maxInputTokens: tokenLimit.optional(),
    scope: text,
    evidence,
  }).strict().optional(),
  compaction: z.object({
    suitability: z.enum(["candidate", "evaluated", "unsuitable", "unknown"]),
    reason: text,
    // Candidate is an editorial inference, never a claim of measured quality.
    evidence,
  }).strict().optional(),
}).strict().superRefine((model, ctx) => {
  if (!model.limits) return;
  if (model.limits.maxInputTokens !== undefined && model.limits.maxInputTokens > model.limits.contextWindowTokens) {
    ctx.addIssue({code: "custom", message: "maxInputTokens exceeds context window"});
  }
  if (model.limits.contextWindowType === "combined" && model.limits.maxOutputTokens > model.limits.contextWindowTokens) {
    ctx.addIssue({code: "custom", message: "maxOutputTokens exceeds combined context window"});
  }
});
export const modelCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  providers: z.array(z.object({
    id: z.enum(["openai", "qwen", "gemini", "meta"]),
    defaultModel: modelId,
    models: z.array(catalogModelSchema).min(1).max(500),
  }).strict()).length(4),
}).strict().superRefine((catalog, ctx) => {
  const invalid = (message: string) => ctx.addIssue({code: "custom", message});
  if (new Set(catalog.providers.map(p => p.id)).size !== 4) invalid("Duplicate providers");
  for (const provider of catalog.providers) {
    const ids = new Set(provider.models.map(m => m.id));
    if (ids.size !== provider.models.length) invalid(`Duplicate models: ${provider.id}`);
    const preferred = provider.models.find(m => m.id === provider.defaultModel);
    if (!preferred || preferred.group !== "primary" || preferred.lifecycle === "retired") invalid(`Invalid default: ${provider.id}`);
    for (const model of provider.models) {
      if (model.group === "primary" && model.lifecycle === "retired") invalid("Retired primary model");
      if (model.replacement && (!ids.has(model.replacement) || model.replacement === model.id)) invalid("Invalid replacement");
    }
  }
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export const bundledModelCatalog: ModelCatalog = modelCatalogSchema.parse(bundled);
export const bundledDefaultModel = (provider: string): string => {
  const entry = bundledModelCatalog.providers.find(p => p.id === provider);
  if (!entry) throw new Error("UNKNOWN_CATALOG_PROVIDER");
  return entry.defaultModel;
};
export function catalogModels(catalog: ModelCatalog, provider: string, current?: string): CatalogModel[] {
  const models = [...(catalog.providers.find(p => p.id === provider)?.models ?? [])]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (current && !models.some(m => m.id === current)) models.unshift({
    id: current, name: current, group: "other", order: 0,
    lifecycle: "unknown", validation: "unverified", capabilities: [],
  });
  return models;
}
export function modelDescription(model: CatalogModel): string {
  return [model.lifecycle === "deprecated" ? "In retirement" : model.lifecycle === "retired" ? "Retired" : "",
    model.validation === "unverified" ? "Unverified" : "Verified in Zhivex",
    model.limits ? `Context: ${model.limits.contextWindowTokens.toLocaleString("en-US")} tokens (${model.limits.contextWindowType}) · Output: ${model.limits.maxOutputTokens.toLocaleString("en-US")}` : "Context: unknown",
    model.reason, model.replacement ? `Suggested replacement: ${model.replacement}` : "",
    model.retirementDate ? `Retirement: ${model.retirementDate}` : ""].filter(Boolean).join(" · ");
}
