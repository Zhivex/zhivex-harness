import type { CliOptions } from "../arguments.js";
import type { HarnessConfig, HarnessProvider } from "../../runtime/config.js";
import { PROVIDERS } from "../../providers/providers.js";
import { loadModelCatalog, type CatalogSnapshot } from "../../models/catalog-store.js";
import { recommendCompactionModels } from "../../models/compaction-recommendations.js";
import { sanitizeTerminalText } from "../terminal/terminal-ui.js";

export interface ConsoleCompactionDependencies {
  config: HarnessConfig;
  options: CliOptions;
  hasActiveTurn(): Promise<unknown>;
  /** Rebuild the harness atomically; leave conversation and approval state intact. */
  replaceOptions(options: CliOptions): Promise<void>;
  inspectCredential(provider: HarnessProvider): Promise<{ configured: boolean }>;
  loadCatalog?(): Promise<CatalogSnapshot>;
  write?(message: string): void;
  now?: number;
}

/** A route change is session-scoped and applies only after a successful rebuild. */
export async function handleConsoleCompaction(command: string, deps: ConsoleCompactionDependencies): Promise<boolean> {
  if (command !== "/compaction" && !command.startsWith("/compaction ")) return false;
  const write = (text: string) => (deps.write ?? (message => { process.stderr.write(message); }))(sanitizeTerminalText(text) + "\n");
  const value = command.slice("/compaction".length).trim();
  if (!value) {
    const route = deps.config.compaction.model;
    write(`Compaction: ${route ? `hybrid using ${route.provider}:${route.model}` : "deterministic (no model call)"}.`);
    write("Use /compaction provider:model, /compaction off, or /compaction recommend. Selection applies to next turns in this CLI session.");
    return true;
  }
  if (value === "recommend") {
    const snapshot = await (deps.loadCatalog ?? loadModelCatalog)();
    write(`Compaction catalog: ${snapshot.catalog.revision} (${snapshot.source}${snapshot.stale ? "; refresh unavailable or stale" : ""}).`);
    write("Advisory estimate: 8,000 input tokens including instructions and 1,024 output tokens. Actual tokenization and cost vary. Credential presence is checked; model access and summary quality are not tested.");
    let configured = 0;
    for (const provider of PROVIDERS) {
      if (!(await deps.inspectCredential(provider)).configured) continue;
      configured++;
      const advice = recommendCompactionModels(snapshot.catalog, {
        provider, inputTokens: 8000, outputTokens: 1024, ...(deps.now === undefined ? {} : {now: deps.now}),
      });
      const best = advice.candidates[0];
      if (!best) {
        write(`${provider}: no supported recommendation with current evidence (${[...new Set(advice.excluded.flatMap(item => item.reasons))].join(", ") || "no catalog entries"}). Custom IDs remain selectable.`);
        continue;
      }
      const limits = best.model.limits!;
      write(`${provider}:${best.model.id} — context ${limits.contextWindowTokens} (${limits.contextWindowType}); max output ${limits.maxOutputTokens}; estimated ${best.estimatedCostUsd === undefined ? "cost unknown" : `$${best.estimatedCostUsd.toFixed(6)} USD`}.`);
      write(`  ${best.model.compaction!.reason} ${best.warnings.length ? `Warnings: ${best.warnings.join(", ")}.` : ""}`);
      if (best.model.pricing) write(`  Price scope: ${best.model.pricing.scope}`);
      write(`  Limits source: ${limits.evidence.sourceUrl} (checked ${limits.evidence.checkedAt}). Select explicitly: /compaction ${provider}:${best.model.id}`);
    }
    if (!configured) write("No configured provider credentials found. Configure credentials before requesting recommendations.");
    write("No model selection changed. Choosing another provider sends bounded conversation excerpts to that provider.");
    return true;
  }
  if (await deps.hasActiveTurn()) {
    write("Finish or deny pending work before changing compaction. The active run and pending approvals were not changed.");
    return true;
  }
  if (value === "off") {
    const next = {...deps.options};
    delete next.compactionModel;
    delete next.compactionProvider;
    await deps.replaceOptions(next);
    write("Next turns: deterministic compaction; model-assisted compaction disabled.");
    return true;
  }
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (separator < 1 || !(PROVIDERS as readonly string[]).includes(provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model)) {
    write("Use /compaction provider:model with openai, qwen, gemini or meta; /compaction off disables model-assisted compaction.");
    return true;
  }
  await deps.replaceOptions({...deps.options, compactionProvider: provider, compactionModel: model});
  write(`Next turns: hybrid compaction using ${provider}:${model}. Bounded conversation excerpts will be sent to this provider; summary quality and account access are not certified by this selection.`);
  return true;
}
