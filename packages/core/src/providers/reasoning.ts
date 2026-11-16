import { z } from "zod";
import { wrapLanguageModel, type LanguageModel, type ModelCapabilities } from "@zhivex-ai/core";
import { DEFAULT_PROVIDER_REGISTRY } from "./providers.js";

export const reasoningEffortSchema = z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type HarnessReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const supportedReasoningEfforts = (capabilities: ModelCapabilities): HarnessReasoningEffort[] =>
  ["default", ...(capabilities.reasoning ? capabilities.reasoningEfforts ?? [] : [])];

/** Capability inspection constructs an adapter only; it performs no requests and
 * neither loads real credentials nor changes process environment. */
export function modelReasoningEfforts(provider: string, model: string): HarnessReasoningEffort[] {
  if (!DEFAULT_PROVIDER_REGISTRY.has(provider)) return ["default"];
  const descriptor = DEFAULT_PROVIDER_REGISTRY.descriptor(provider);
  const env = Object.fromEntries(descriptor.credentialNames.map(name => [name, "capability-inspection-only"]));
  return supportedReasoningEfforts(DEFAULT_PROVIDER_REGISTRY.createModel({provider, model}, env).capabilities);
}
export function withReasoningEffort(model: LanguageModel, value?: HarnessReasoningEffort): LanguageModel {
  if (!value || value === "default") return model;
  if (!supportedReasoningEfforts(model.capabilities).includes(value)) throw new Error(`Reasoning effort ${value} is not declared for ${model.provider}/${model.modelId}. Use default or a supported level.`);
  return wrapLanguageModel(model, [{
    name: `harness-reasoning-${value}`,
    async wrapGenerate(context, next) { context.input.reasoning = {...context.input.reasoning, effort: value}; return next(); },
    async wrapStream(context, next) { context.input.reasoning = {...context.input.reasoning, effort: value}; return next(); }
  }]);
}
