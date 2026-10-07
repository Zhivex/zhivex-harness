import { fileURLToPath } from "node:url";
import { createHarness, resolveHarnessConfig, providerAvailability } from "@zhivex-ai/harness/engine";
import { bundledModelCatalog, catalogModels } from "@zhivex-ai/harness/code-support";
import { protectPersistenceSecret } from "@zhivex-ai/harness/desktop/v1/state";
import { runWebCli } from "../../web/src/cli.js";
import { CliCredentials, credentialModel } from "./cli/cli-credentials.js";
import { interactiveBudgetOptions } from "./cli/console/console-budget.js";
import { applyCliProfile, resolveCliDefaults } from "./cli/cli-profiles.js";

export async function runWeb(args: string[]) {
  const credentials = new CliCredentials(undefined, process.env, () => {});
  await runWebCli(
    args,
    fileURLToPath(new URL("./web-assets/", import.meta.url)),
    async (input, profile, interactive) => {
      const configuredOptions = await applyCliProfile(
        await resolveCliDefaults({ ...input, ...(profile ? { profile } : {}) }),
      );
      const options = interactive ? interactiveBudgetOptions(configuredOptions) : configuredOptions;
      const config = resolveHarnessConfig(options);
      if (!(await credentials.inspect(config.provider)).configured)
        throw new Error("WEB_CREDENTIALS_REQUIRED");
      // Read existing credentials only. No browser/launcher credential setup or new grants.
      const env = await credentials.providerEnvironment(config.provider, {
        select: async () => undefined,
        secret: async () => {
          throw new Error("WEB_CREDENTIALS_REQUIRED");
        },
      });
      const secrets = Object.entries(env)
        .filter(
          ([k, v]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(k) && v,
        )
        .map(([, v]) => v!);
      for (const value of secrets) protectPersistenceSecret(value);
      const model = await credentialModel(config, env);
      return {
        harness: await createHarness({
          ...options,
          provider: config.provider,
          model: config.model,
          modelInstance: model,
          env,
          storeBackend: "sqlite",
          usageAccounting: {},
          subagentProfiles: [],
        }),
        secrets,
      };
    },
    async () => {
      const providers = providerAvailability(process.env);
      return (await Promise.all(providers.map(async provider => {
        const status = await credentials.inspect(provider.id);
        return catalogModels(bundledModelCatalog, provider.id)
          .filter(model => model.capabilities.includes("chat") && model.capabilities.includes("tools") && model.lifecycle !== "retired")
          .map(model => ({provider: provider.id, providerName: provider.name, model: model.id,
            name: model.name, configured: status.configured, capabilities: model.capabilities,
            validation: model.validation}));
      }))).flat();
    },
  );
}
