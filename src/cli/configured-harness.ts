import { CliCredentials, credentialModel } from "./cli-credentials.js";
import { usagePricingSchema } from "../runtime/usage-ledger.js";
import { ConsoleInput } from "./console/console-input.js";
import path from "node:path";
import { createProviderModel, resolveHarnessConfig, type HarnessSubagentProfile } from "../runtime/config.js";
import { createHarness } from "../runtime/harness.js";
import { createHarnessRouteModels, type HarnessModelRoute } from "../providers/routing.js";
import { readRegularFileNoFollow } from "../workspace/file-security.js";
import { CliUsageError, type CliOptions } from "./arguments.js";
import { assertRoutePricingIsSafe, resolvedRouting } from "./routing.js";
import { orchestrationObserver } from "./presentation.js";

export const createConfiguredHarness = async (
  options: CliOptions,
  extraProfiles: readonly HarnessSubagentProfile[] = [],
  persistedRoutes?: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>,
  credentials?: { store: CliCredentials; input: ConsoleInput }
) => {
  const routes = persistedRoutes ?? resolvedRouting(options);
  const resolvedConfig = resolveHarnessConfig(options);
  if (options.usageLimitUsd !== undefined && resolvedConfig.costBudget) throw new CliUsageError("Choose one monetary policy: --usage-limit-usd or the legacy cost budget.");
  assertRoutePricingIsSafe(routes, resolvedConfig.costBudget);
  const profiles = [...new Set([
    ...(options.subagentProfiles ?? []),
    ...extraProfiles,
    ...routes.keys()
  ])];
  const quietTelemetry = options.json || options.jsonl;
  const providerEnv = credentials ? await credentials.store.providerEnvironment(resolvedConfig.provider, credentials.input) : undefined;
  const routeModels: ReturnType<typeof createHarnessRouteModels> = {};
  for (const [role, route] of routes) {
    routeModels[role] = credentials
      ? await credentialModel(route, await credentials.store.providerEnvironment(route.provider, credentials.input))
      : createProviderModel(route, process.env);
  }
  const harness = await createHarness({
    ...options,
    usageAccounting: {
      ...(options.pricingFile ? { pricing: usagePricingSchema.parse(JSON.parse((await readRegularFileNoFollow(path.resolve(options.pricingFile), { maxBytes: 128 * 1024, label: "Usage pricing" })).contents.toString("utf8"))) } : {}),
      ...(options.usageLimitUsd !== undefined ? { limitUsd: options.usageLimitUsd } : {})
    },
    subagentProfiles: profiles,
    subagentModels: routeModels,
    ...(providerEnv ? { modelInstance: await credentialModel(resolvedConfig, providerEnv) } : {}),
    onTelemetryEvent: orchestrationObserver(quietTelemetry)
  });
  return { harness, routes };
};
