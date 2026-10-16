import type { WebModelChoice } from "./contracts.js";

export interface CatalogChoiceInput {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  configured: boolean;
  capabilities: readonly string[];
  validation: string;
  group?: "primary" | "other";
  order?: number;
  limits?: { contextWindowTokens: number; contextWindowType: "combined" | "input" };
  pricing?: { currency?: string; inputPerMillionTokens: number; outputPerMillionTokens: number };
}

/** Copy only fields the catalog actually published. Never invent cost, context, or capabilities. */
export function toWebModelChoice(input: CatalogChoiceInput): WebModelChoice {
  return {
    provider: input.provider,
    providerName: input.providerName,
    model: input.id,
    name: input.name,
    configured: input.configured,
    capabilities: [...input.capabilities],
    validation: input.validation,
    ...(input.group ? { group: input.group } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
    ...(input.limits ? { contextWindow: { tokens: input.limits.contextWindowTokens, type: input.limits.contextWindowType } } : {}),
    ...(input.pricing && input.pricing.currency === "USD" ? {
      cost: {
        currency: "USD" as const,
        inputPerMillionTokens: input.pricing.inputPerMillionTokens,
        outputPerMillionTokens: input.pricing.outputPerMillionTokens,
      },
    } : {}),
  };
}

export function choiceKey(choice: Pick<WebModelChoice, "provider" | "model">) {
  return `${choice.provider}/${choice.model}`;
}

export function formatContext(choice: WebModelChoice) {
  if (!choice.contextWindow) return "";
  const tokens = choice.contextWindow.tokens.toLocaleString("en-US");
  return choice.contextWindow.type === "input" ? `${tokens} input tokens` : `${tokens} tokens`;
}

export function formatCost(choice: WebModelChoice) {
  if (!choice.cost || choice.cost.currency !== "USD") return "";
  const money = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `${money(choice.cost.inputPerMillionTokens)} in / ${money(choice.cost.outputPerMillionTokens)} out per 1M`;
}

export function showsImages(choice: WebModelChoice) {
  return choice.capabilities.includes("vision");
}
