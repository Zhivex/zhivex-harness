/** Presence checks only. Never print values or contact a provider before all routes are configured. */
export function missingLiveReleaseConfig(env: NodeJS.ProcessEnv): string[] {
  const present = (name: string) => Boolean(env[name]?.trim());
  const required = ["OPENAI_API_KEY", "MODEL_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION", "VERTEX_WORKLOAD_IDENTITY_PROVIDER", "VERTEX_SERVICE_ACCOUNT"];
  const missing = required.filter(name => !present(name));
  if (!present("QWEN_API_KEY") && !present("DASHSCOPE_API_KEY")) missing.push("QWEN_API_KEY or DASHSCOPE_API_KEY");
  return missing;
}

if (import.meta.main) {
  const missing = missingLiveReleaseConfig(process.env);
  if (missing.length) throw new Error(`Missing protected live-certification configuration: ${missing.join(", ")}`);
  console.log("All six routes have protected configuration; authentication and live gates remain required.");
}
