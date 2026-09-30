import { modelReasoningEfforts } from "../providers/reasoning.js";
import { ConsoleInput } from "./console/console-input.js";
import { navigateConsole } from "./console/console-navigation.js";
import { parseProvider, providerAvailability, providerDescriptor, type HarnessProvider } from "../runtime/config.js";
import { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import type { CliInitDocument } from "../client/json-contracts.js";
import { createCliProfile, loadCliProfile, updateCliProfile } from "./cli-profiles.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

export const providersDocument = (env: NodeJS.ProcessEnv = process.env) => ({
  schemaVersion: CLI_JSON_SCHEMA_VERSION,
  kind: "providers" as const,
  providers: providerAvailability(env)
});

export const initializeCli = async (options: CliOptions, context: { onboarding?: boolean } = {}) => {
  const profileName = options.profile ?? "default";
  const existing = options.updateProfile ? await loadCliProfile(profileName) : undefined;
  const envProvider = options.provider ?? existing?.provider ?? process.env.ZHIVEX_HARNESS_PROVIDER;
  let provider: HarnessProvider;
  try {
    provider = parseProvider(envProvider);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  let reasoningEffort = options.reasoningEffort ?? existing?.reasoningEffort;
  let model = options.model ?? (existing
    ? existing.provider === provider ? existing.model : providerDescriptor(provider).defaultModel
    : process.env.ZHIVEX_HARNESS_MODEL ?? providerDescriptor(provider).defaultModel);
  if (existing && (existing.provider !== provider || existing.model !== model) && options.reasoningEffort === undefined) reasoningEffort = undefined;
  if (!options.json && process.stdin.isTTY && process.stdout.isTTY) {
    const input = new ConsoleInput(process.stdin, process.stdout);
    try {
      if (!options.provider || !options.model) {
        const providers = [...providerAvailability()].sort((a, b) =>
          Number(b.configured) - Number(a.configured) || Number(b.id === provider) - Number(a.id === provider));
        const selected = await navigateConsole(input, {
          entry: options.provider ? "model" : "provider", current: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
          providers, sessions: async () => [],
        });
        if (!selected || "command" in selected) {
          process.stdout.write("Setup cancelled. No profile was changed. Run zhx to try again.\n");
          return false;
        }
        provider = parseProvider(selected.provider);
        model = options.model ?? selected.model;
        reasoningEffort = options.reasoningEffort ?? selected.reasoningEffort;
      }
    } finally { input.close(); }
  }

  if (reasoningEffort && !modelReasoningEfforts(provider, model).includes(reasoningEffort)) {
    throw new CliUsageError(`Reasoning effort ${reasoningEffort} is not declared for ${provider}/${model}. Use default or a supported level.`);
  }
  const created = await (options.updateProfile ? updateCliProfile : createCliProfile)(profileName, { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
  const availability = providerAvailability().find((candidate) => candidate.id === provider);
  const doctorCommand = `zhx doctor --profile ${profileName}`;
  const runCommand = `zhx --profile ${profileName} "inspect this repository"`;
  const document: CliInitDocument = {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    kind: "init",
    profile: {
      name: profileName,
      path: created.path,
      schemaVersion: created.profile.schemaVersion,
      provider: created.profile.provider,
      model: created.profile.model,
      reasoningEffort: created.profile.reasoningEffort ?? "default"
    },
    credential: {
      configured: availability?.configured ?? false,
      names: [...(availability?.credentialNames ?? [])]
    },
    next: { doctor: doctorCommand, run: runCommand }
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return true;
  }
  if (context.onboarding) {
    process.stdout.write(`Provider and model saved. Reasoning: ${created.profile.reasoningEffort ?? "default"}. Next: configure credentials for ${provider}.\n`);
    return true;
  }
  process.stdout.write([
    `${options.updateProfile ? "Updated" : "Created"} personal profile ${profileName} at ${created.path}.`,
    `Provider: ${created.profile.provider} · Model: ${created.profile.model} · Reasoning: ${created.profile.reasoningEffort ?? "default"}`,
    provider === "vertex"
      ? "Vertex uses host ADC. Set GOOGLE_CLOUD_PROJECT and VERTEX_LOCATION; route presence does not verify credentials or model access."
      : availability?.configured
      ? "Provider credential detected; no secret value was stored or printed."
      : `Open zhx to configure a managed key, or set ${availability?.credentialNames.join(" or ") || "the provider credential"} for automation.`,
    "Next:",
    `  ${doctorCommand}`,
    `  ${runCommand}`,
    "Profiles contain provider, model and optional reasoning effort. A later bare interactive console uses the default profile automatically. Change it with zhx init --update."
  ].join("\n") + "\n");
  return true;
};

export const listProviders = (json: boolean) => {
  const document = providersDocument();
  if (json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  for (const provider of document.providers) {
    process.stdout.write(
      `${provider.id.padEnd(7)} ${provider.defaultModel.padEnd(22)} ${provider.support.padEnd(11)} ${provider.id === "vertex" ? provider.configured ? "route configured; ADC not checked" : "missing GOOGLE_CLOUD_PROJECT/VERTEX_LOCATION" : provider.configured ? "configured" : `missing ${provider.credentialNames.join("/")}`}\n`
    );
  }
};
