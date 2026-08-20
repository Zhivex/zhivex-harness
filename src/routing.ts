import type { LanguageModel } from "@zhivex-ai/agents";

import {
  DEFAULT_PROVIDER_REGISTRY,
  HARNESS_SUBAGENT_PROFILES,
  type HarnessProviderRegistry,
  type HarnessSubagentProfile
} from "./config.js";

export interface HarnessModelRoute {
  profile: HarnessSubagentProfile;
  provider: string;
  model: string;
}

const routeError = (value: string) => new Error(
  `Invalid route: ${value}. Use <profile>=<provider>[:<model>].`
);

export const parseHarnessModelRoute = (
  value: string,
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
): HarnessModelRoute => {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw routeError(value);
  }
  const profile = value.slice(0, separator).trim().toLowerCase();
  if (!(HARNESS_SUBAGENT_PROFILES as readonly string[]).includes(profile)) {
    throw routeError(value);
  }
  const target = value.slice(separator + 1).trim();
  const modelSeparator = target.indexOf(":");
  const providerInput = (modelSeparator === -1 ? target : target.slice(0, modelSeparator)).trim();
  const provider = registry.parse(providerInput);
  const configuredModel = modelSeparator === -1 ? "" : target.slice(modelSeparator + 1).trim();
  if (modelSeparator !== -1 && !configuredModel) {
    throw routeError(value);
  }
  const model = configuredModel || registry.descriptor(provider).defaultModel;
  if (/[\u0000-\u001f\u007f]/.test(model) || model.length > 256) {
    throw routeError(value);
  }
  return Object.freeze({
    profile: profile as HarnessSubagentProfile,
    provider,
    model
  });
};

export const resolveHarnessModelRoutes = (
  values: readonly string[] = [],
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
) => {
  const routes = new Map<HarnessSubagentProfile, HarnessModelRoute>();
  for (const value of values) {
    const route = parseHarnessModelRoute(value, registry);
    if (routes.has(route.profile)) {
      throw new Error(`Duplicate model route for ${route.profile}.`);
    }
    routes.set(route.profile, route);
  }
  return routes;
};

export const createHarnessRouteModels = (
  routes: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>,
  env: NodeJS.ProcessEnv = process.env,
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
) => Object.fromEntries([...routes].map(([profile, route]) => [
  profile,
  registry.createModel(route, env)
])) as Partial<Record<HarnessSubagentProfile, LanguageModel>>;

export const serializeHarnessModelRoutes = (
  routes: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>
) => Object.fromEntries([...routes].map(([profile, route]) => [
  profile,
  { provider: route.provider, model: route.model }
]));
