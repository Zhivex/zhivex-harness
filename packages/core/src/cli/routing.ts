import { type HarnessConfig, type HarnessSubagentProfile } from "../runtime/config.js";
import { resolveHarnessModelRoutes, type HarnessModelRoute } from "../providers/routing.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

export const resolvedRouting = (options: CliOptions) => {
  return resolveHarnessModelRoutes(options.routes);
};

export const assertRoutePricingIsSafe = (
  routes: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>,
  costBudget: HarnessConfig["costBudget"]
) => {
  if (routes.size > 0 && costBudget !== undefined) {
    throw new CliUsageError(
      "Cost budgets cannot be combined with model routes until pricing is configured per role."
    );
  }
};

export const withTemporaryHarnessProfiles = async <T>(
  profiles: readonly HarnessSubagentProfile[],
  configure: (profiles: readonly HarnessSubagentProfile[]) => Promise<void>,
  operation: () => Promise<T>
): Promise<T> => {
  await configure(profiles);
  try {
    return await operation();
  } finally {
    await configure([]);
  }
};
