import type { ConsoleInput } from "./console-input.js";
import { bundledModelCatalog, catalogModels, modelDescription, type ModelCatalog } from "../../models/catalog.js";
import { loadModelCatalog } from "../../models/catalog-store.js";
import type { ProviderAvailability } from "../../providers/providers.js";

export const consoleModelChoices = (provider: string, defaultModel: string, current?: string, catalog: ModelCatalog = bundledModelCatalog) => {
  const models = catalogModels(catalog, provider, current);
  return [...new Set([...(current ? [current] : []), defaultModel, ...models.map(m => m.id)])].map(model => {
    const entry = models.find(m => m.id === model);
    return {
      value: model, label: entry?.name ?? model,
      group: entry?.group ?? "other",
      detail: [model === current ? "Current" : "", model === defaultModel ? "Recommended default" : "",
        entry ? modelDescription(entry) : "Unverified"].filter(Boolean).join(" · "),
    };
  });
};

export type ConsoleNavigationResult = { command: string } | { provider: string; model: string };

export const navigateConsole = async (
  input: Pick<ConsoleInput, "select" | "question">,
  options: {
    entry: "menu" | "provider" | "model";
    current: {provider: string; model: string};
    providers: readonly ProviderAvailability[];
    sessions: () => Promise<readonly {value: string; label: string; detail?: string}[]>;
    service?: boolean;
  },
): Promise<ConsoleNavigationResult | undefined> => {
  const snapshot = options.service ? undefined : await loadModelCatalog();
  let page: "menu" | "provider" | "model" | "sessions" = options.entry;
  let provider = options.current.provider;
  let modelParent: "menu" | "provider" | undefined = options.entry === "model" ? undefined : "provider";
  for (;;) {
    if (page === "menu") {
      const action = await input.select("Zhivex / Menu", [
        ...(!options.service ? [
          {value:"provider",label:"Providers",detail:"Browse providers and their models"},
          {value:"model",label:"Models",detail:`Browse ${options.current.provider} models`},
          {value:"/credentials",label:"Credentials",detail:"System keychain or temporary API keys"},
        ] : []),
        {value:"sessions",label:"Conversations",detail:"Find and resume a saved conversation"},
        {value:"/status",label:"Status",detail:"Current session and runtime"},
        {value:"/pending",label:"Pending approvals",detail:"Inspect pending actions"},
        ...(!options.service ? [
          {value:"/context",label:"Project context",detail:"Rules, skills and attachments"},
          {value:"/usage",label:"Usage",detail:"Transport usage and estimates"},
        ] : []),
        {value:"/help",label:"Help",detail:"All commands and keyboard shortcuts"},
      ]);
      if (!action) return;
      if (action.startsWith("/")) return {command:action};
      page = action as "provider" | "model" | "sessions";
      if (page === "model") { provider = options.current.provider; modelParent = "menu"; }
    } else if (page === "provider") {
      const selected = await input.select("Zhivex / Providers", options.providers.map(p => ({
        value:p.id,label:p.name,
        detail:`${p.id} · ${p.configured ? "credential present" : "credential missing"}${p.support === "provisional" ? " · provisional" : ""}`,
      })));
      if (!selected) { if (options.entry === "provider") return; page = "menu"; continue; }
      provider = selected; modelParent = "provider"; page = "model";
    } else if (page === "sessions") {
      const selected = await input.select("Zhivex / Conversations", await options.sessions());
      if (selected) return {command:`/resume ${selected}`};
      page = "menu";
    } else {
      const descriptor = options.providers.find(p => p.id === provider);
      if (!descriptor) return;
      const catalog = snapshot?.catalog ?? bundledModelCatalog;
      const defaultModel = catalog.providers.find(p => p.id === provider)?.defaultModel ?? descriptor.defaultModel;
      const choices = consoleModelChoices(provider, defaultModel,
        options.current.provider === provider ? options.current.model : undefined, catalog);
      const primary = choices.filter(item => item.group === "primary" || (provider === options.current.provider && item.value === options.current.model));
      const others = choices.filter(item => item.group === "other");
      let selected = await input.select<{kind:"model"|"custom"|"other";id:string}>(`Zhivex / Providers / ${descriptor.name} / Models\nPrimary models · ${snapshot?.source ?? "bundled"}${snapshot?.stale ? " (offline fallback)" : ""} · account access is not checked`, [
        ...primary.map(item => ({...item,value:{kind:"model" as const,id:item.value}})),
        ...(others.length ? [{value:{kind:"other" as const,id:""},label:"Other models…",detail:"Additional, unverified or retiring models"}] : []),
        {value:{kind:"custom" as const,id:""},label:"Custom model ID…",detail:"Enter a model absent from the local catalog"},
      ]);
      if (!selected) { if (!modelParent) return; page = modelParent; continue; }
      if (selected.kind === "other") {
        selected = await input.select<{kind:"model";id:string}>("Zhivex / Other models · account access is not checked", others.map(item => ({...item, value:{kind:"model" as const,id:item.value}})));
        if (!selected) continue;
      }
      if (selected.kind === "custom") {
        let prompt = "Model ID (Enter to go back): ";
        for (;;) {
          const model = (await input.question(prompt)).trim();
          if (!model) break;
          if (model.length <= 512 && !/[\u0000-\u001f\u007f]/.test(model)) return {provider,model};
          prompt = "Use 1–512 printable characters. Model ID (Enter to go back): ";
        }
        continue;
      }
      return {provider,model:selected.id};
    }
  }
};
