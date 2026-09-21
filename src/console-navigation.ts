import type { ConsoleInput } from "./console-input.js";
import { CONSOLE_MODEL_CATALOG } from "./console-model-catalog.js";
import type { ProviderAvailability } from "./providers.js";

export const consoleModelChoices = (provider: string, defaultModel: string, current?: string) => {
  const snapshot = CONSOLE_MODEL_CATALOG.providers[provider as keyof typeof CONSOLE_MODEL_CATALOG.providers];
  return [...new Set([...(current ? [current] : []), defaultModel, ...(snapshot?.models ?? [])])].map(model => ({
    value: model,
    label: model,
    detail: model === current ? "Current" : model === defaultModel ? "Provider default" : `SDK catalog ${snapshot?.revision ?? ""}`,
  }));
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
      const choices = consoleModelChoices(provider, descriptor.defaultModel,
        options.current.provider === provider ? options.current.model : undefined);
      const selected = await input.select<{kind:"model"|"custom";id:string}>(`Zhivex / Providers / ${descriptor.name} / Models\nLocal catalog · account access is not checked`, [
        ...choices.map(item => ({...item,value:{kind:"model" as const,id:item.value}})),
        {value:{kind:"custom" as const,id:""},label:"Custom model ID…",detail:"Enter a model absent from the local catalog"},
      ]);
      if (!selected) { if (!modelParent) return; page = modelParent; continue; }
      if (selected.kind === "custom") {
        const model = (await input.question("Model ID (Enter to go back): ")).trim();
        if (!model) continue;
        return {provider,model};
      }
      return {provider,model:selected.id};
    }
  }
};
