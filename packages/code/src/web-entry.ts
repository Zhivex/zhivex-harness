import { fileURLToPath } from "node:url";
import { createHarness, resolveHarnessConfig } from "@zhivex-ai/harness/engine";
import { protectPersistenceSecret } from "@zhivex-ai/harness/desktop/v1/state";
import { runWebCli } from "../../web/src/cli.js";
import { CliCredentials, credentialModel } from "./cli/cli-credentials.js";
import { applyCliProfile, resolveCliDefaults } from "./cli/cli-profiles.js";

export async function runWeb(args: string[]) {
  await runWebCli(
    args,
    fileURLToPath(new URL("./web-assets/", import.meta.url)),
    async (input, profile) => {
      const options = await applyCliProfile(
        await resolveCliDefaults({ ...input, ...(profile ? { profile } : {}) }),
      );
      const config = resolveHarnessConfig(options);
      const credentials = new CliCredentials(undefined, process.env, () => {});
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
          subagentProfiles: [],
        }),
        secrets,
      };
    },
  );
}
