import type { HarnessProvider } from "../src/runtime/config.js";

const liveRoutes = ["meta", "qwen", "openai", "anthropic", "gemini", "vertex"] as const;

export function liveCertificationProviders(env: NodeJS.ProcessEnv): HarnessProvider[] {
  const selected = env.ZHIVEX_HARNESS_LIVE_PROVIDERS === undefined ? [...liveRoutes] :
    [...new Set(env.ZHIVEX_HARNESS_LIVE_PROVIDERS.split(",").map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (!selected.length || selected.some(value => !(liveRoutes as readonly string[]).includes(value))) {
    throw new Error("Live certification must select supported release routes.");
  }
  return selected as HarnessProvider[];
}

/** Presence checks only. Never print values or contact a provider before selected routes are configured. */
export function missingLiveReleaseConfig(env: NodeJS.ProcessEnv): string[] {
  const providers = liveCertificationProviders(env);
  const present = (name: string) => Boolean(env[name]?.trim());
  const required = [
    ...(providers.includes("openai") ? ["OPENAI_API_KEY"] : []),
    ...(providers.includes("meta") ? ["MODEL_API_KEY"] : []),
    ...(providers.includes("anthropic") ? ["ANTHROPIC_API_KEY"] : []),
    ...(providers.includes("gemini") ? ["GEMINI_API_KEY"] : []),
    ...(providers.includes("vertex") ? ["GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION", "VERTEX_WORKLOAD_IDENTITY_PROVIDER", "VERTEX_SERVICE_ACCOUNT"] : [])
  ];
  const missing = required.filter(name => !present(name));
  if (providers.includes("qwen") && !present("QWEN_API_KEY") && !present("DASHSCOPE_API_KEY")) missing.push("QWEN_API_KEY or DASHSCOPE_API_KEY");
  return missing;
}

if (import.meta.main) {
  const missing = missingLiveReleaseConfig(process.env);
  if (missing.length) throw new Error(`Missing protected live-certification configuration: ${missing.join(", ")}`);
  console.log("Selected routes have protected configuration; authentication and live gates remain required.");
}
