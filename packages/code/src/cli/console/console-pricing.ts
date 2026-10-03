import { loadModelCatalog, usagePricingSchema, readRegularFileNoFollow, type ModelCatalog } from "@zhivex-ai/harness/code-support";
import path from "node:path";
import type { CliOptions } from "../arguments.js";
import type { ConsoleInput } from "./console-input.js";
import { sanitizeTerminalText } from "../terminal/terminal-ui.js";

export const catalogPrice = (model: ModelCatalog["providers"][number]["models"][number] | undefined) => {
  const price = model?.pricing;
  return price ? `Estimated USD / 1M tokens: input $${price.inputPerMillionTokens}; output $${price.outputPerMillionTokens} · checked ${price.evidence.checkedAt}${price.maxInputTokens ? ` · input tier ≤${price.maxInputTokens}` : ""}`
    : "Price: unknown";
};

export const handleConsoleBudget = async (command: string, context: {
  options: CliOptions; provider: string; model: string;
  input: Pick<ConsoleInput, "select" | "question">;
  hasActiveTurn: () => Promise<unknown>; replaceOptions: (options: CliOptions) => Promise<void>;
  write?: (text: string) => void;
}) => {
  if (command !== "/budget" && !command.startsWith("/budget ") && command !== "/pricing") return false;
  const write = context.write ?? (text => { process.stdout.write(text); });
  write("Monetary policies are per RUN; every new turn, /continue and review group starts a new budget. Resuming a pending run retains its original policy. Estimates are not invoices or guaranteed financial caps.\n");
  if (command === "/pricing") {
    const snapshot = await loadModelCatalog();
    const model = snapshot.catalog.providers.find(item => item.id === context.provider)?.models.find(item => item.id === context.model);
    write(`${sanitizeTerminalText(context.provider + "/" + context.model)} · ${catalogPrice(model)}\n`);
    if (model?.pricing) write(sanitizeTerminalText(`Scope: ${model.pricing.scope}\nSource: ${model.pricing.evidence.sourceUrl}\n`));
    write("Catalog prices are advisory. Monetary execution limits use an explicit operator pricing file with validity dates for every active route.\n");
    return true;
  }
  write(`Next run estimated USD limit: ${context.options.usageLimitUsd ?? "off"}; pricing file: ${sanitizeTerminalText(context.options.pricingFile ?? "none")}\n`);
  if (await context.hasActiveTurn()) { write("Finish or deny pending work before changing the next-run policy.\n"); return true; }
  if (context.options.maxCostUsd !== undefined || process.env.ZHIVEX_HARNESS_MAX_COST_USD !== undefined) {
    write("A legacy measured-cost policy is configured. Start a console without it before selecting the transport-ledger policy.\n"); return true;
  }
  const argument = command.slice("/budget".length).trim();
  const selected = argument || await context.input.select("Budget for each next run", [
    { value: "", label: "Keep current policy" },
    { value: "set", label: "Set estimated USD limit and pricing file" },
    { value: "off", label: "Disable monetary limit", detail: "Other step, tool, time and token limits still apply" },
  ]);
  if (!selected) return true;
  if (selected === "off") {
    const next = { ...context.options }; delete next.usageLimitUsd;
    await context.replaceOptions(next); write("Monetary limit disabled for next runs.\n"); return true;
  }
  const amount = selected === "set" ? (await context.input.question("Estimated USD limit per new run: ")).trim() : selected;
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    write("Use a positive finite USD amount, or /budget off.\n"); return true;
  }
  const file = (await context.input.question(`Pricing JSON file${context.options.pricingFile ? ` (Enter keeps ${sanitizeTerminalText(context.options.pricingFile)})` : ""}: `)).trim() || context.options.pricingFile;
  if (!file) { write("Pricing file required; policy unchanged.\n"); return true; }
  const pricing = usagePricingSchema.parse(JSON.parse((await readRegularFileNoFollow(path.resolve(file), { maxBytes: 128 * 1024, label: "Usage pricing" })).contents.toString("utf8")));
  const price = pricing.prices.find(item => item.provider === context.provider && item.model === context.model);
  if (!price || Date.parse(price.asOf) > Date.now() || Date.parse(price.expiresAt) <= Date.now()) {
    write("Current model price is missing or stale; policy unchanged.\n"); return true;
  }
  write(sanitizeTerminalText(`Operator estimate: input $${price.inputUsdPerMillion}, output $${price.outputUsdPerMillion} / 1M tokens.\nSource: ${price.source}; valid ${price.asOf} through ${price.expiresAt}.\n`));
  write("The engine reserves estimated requests with an output cap (up to 2048 tokens), and blocks missing/stale prices, uncertain usage or insufficient estimated budget. Other routes also require valid prices.\n");
  if ((await context.input.question(`Type budget to apply $${amount} per new run: `)).trim() !== "budget") return true;
  await context.replaceOptions({ ...context.options, pricingFile: path.resolve(file), usageLimitUsd: Number(amount) });
  write(`Estimated USD limit set: $${amount} per new run.\n`);
  return true;
};
