import { z } from "zod";
import bundled from "./catalog.json";

const modelId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const text = z.string().min(1).max(300).regex(/^[^\x00-\x1f\x7f-\x9f]*$/);
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
}).strict();
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
    model.reason, model.replacement ? `Suggested replacement: ${model.replacement}` : "",
    model.retirementDate ? `Retirement: ${model.retirementDate}` : ""].filter(Boolean).join(" · ");
}
