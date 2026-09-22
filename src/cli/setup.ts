import { sanitizeTerminalText } from "./terminal/terminal-ui.js";
import { createInterface } from "node:readline/promises";
import { PROVIDERS, parseProvider, providerAvailability, providerDescriptor, type HarnessProvider } from "../runtime/config.js";
import { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import type { CliInitDocument } from "../client/json-contracts.js";
import { createCliProfile } from "./cli-profiles.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

export const providersDocument = (env: NodeJS.ProcessEnv = process.env) => ({
  schemaVersion: CLI_JSON_SCHEMA_VERSION,
  kind: "providers" as const,
  providers: providerAvailability(env)
});

export const confirmDefaultProfileSelection = async (
  profile: { provider: HarnessProvider; model: string },
  ask: (prompt: string) => Promise<string>
) => {
  const selected = { provider: profile.provider, model: profile.model };
  const provider = sanitizeTerminalText(selected.provider);
  const model = sanitizeTerminalText(selected.model);
  const answer = (await ask(`Use default profile ${provider}/${model}? [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes" ? selected : undefined;
};

export const initializeCli = async (options: CliOptions) => {
  const profileName = options.profile ?? "default";
  const envProvider = options.provider ?? process.env.ZHIVEX_HARNESS_PROVIDER;
  let provider: HarnessProvider;
  try {
    provider = parseProvider(envProvider);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  let model = options.model ?? process.env.ZHIVEX_HARNESS_MODEL ?? providerDescriptor(provider).defaultModel;
  if (!options.json && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!options.provider) {
        const answer = (await readline.question(
          `Provider (${PROVIDERS.join("/")}) [${provider}]: `
        )).trim();
        if (answer) {
          try {
            provider = parseProvider(answer);
          } catch (error) {
            throw new CliUsageError(error instanceof Error ? error.message : String(error));
          }
          if (!options.model) model = providerDescriptor(provider).defaultModel;
        }
      }
      if (!options.model) {
        const answer = (await readline.question(`Model [${model}]: `)).trim();
        if (answer) model = answer;
      }
    } finally {
      readline.close();
    }
  }

  const created = await createCliProfile(profileName, { provider, model });
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
      model: created.profile.model
    },
    credential: {
      configured: availability?.configured ?? false,
      names: [...(availability?.credentialNames ?? [])]
    },
    next: { doctor: doctorCommand, run: runCommand }
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `Created personal profile ${profileName} at ${created.path}.`,
    `Provider: ${created.profile.provider} · Model: ${created.profile.model}`,
    availability?.configured
      ? "Provider credential detected; no secret value was stored or printed."
      : `Open zhx to configure a managed key, or set ${availability?.credentialNames.join(" or ") || "the provider credential"} for automation.`,
    "Next:",
    `  ${doctorCommand}`,
    `  ${runCommand}`,
    "Profiles contain provider and model only. A later bare interactive console asks before using the default profile."
  ].join("\n") + "\n");
};

export const listProviders = (json: boolean) => {
  const document = providersDocument();
  if (json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  for (const provider of document.providers) {
    process.stdout.write(
      `${provider.id.padEnd(7)} ${provider.defaultModel.padEnd(22)} ${provider.support.padEnd(11)} ${provider.configured ? "configured" : `missing ${provider.credentialNames.join("/")}`}\n`
    );
  }
};

