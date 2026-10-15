import { createBedrock } from "@zhivex-ai/bedrock";
import { wrapLanguageModel, type LanguageModel, type StreamEvent } from "@zhivex-ai/core";

/** Transport settings hashed into durable resumes. Secrets stay out of this list. */
export const BEDROCK_TRANSPORT_ENVIRONMENT = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "BEDROCK_RUNTIME",
  "BEDROCK_OPENAI_BASE_URL"
] as const;

export const BEDROCK_CREDENTIAL_ENVIRONMENT = [
  "BEDROCK_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK"
] as const;

/**
 * SDK matrix: Converse is Tier B and `runtime: "openai"` is Tier A.
 * Published `@zhivex-ai/bedrock@2.0.7` reports those labels. Converse includes
 * reasoning and `toolChoiceNone`. Harness reports the installed label and
 * does not relabel the model.
 */
export const BEDROCK_MATRIX_TIER = {
  converse: "tier-b",
  openai: "tier-a"
} as const;

const REGION = /^[a-z]{2}(?:-[a-z0-9]+){1,3}$/;

export type BedrockRuntime = "converse" | "openai";

export function bedrockRuntime(env: NodeJS.ProcessEnv): BedrockRuntime {
  const value = env.BEDROCK_RUNTIME?.trim() ?? "";
  if (!value || value === "converse") return "converse";
  if (value === "openai") return "openai";
  throw new Error("BEDROCK_RUNTIME must be converse or openai.");
}

/** Region only. Does not contact AWS or read the credential chain. */
export function bedrockRegion(env: NodeJS.ProcessEnv): string {
  const region = (env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "");
  if (!REGION.test(region)) {
    throw new Error("Bedrock requires a valid AWS_REGION or AWS_DEFAULT_REGION.");
  }
  return region;
}

export function bedrockOpenAIBaseURL(env: NodeJS.ProcessEnv): string {
  const baseURL = env.BEDROCK_OPENAI_BASE_URL?.trim() ?? "";
  if (!baseURL) throw new Error("Bedrock OpenAI-compatible runtime requires BEDROCK_OPENAI_BASE_URL.");
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error("BEDROCK_OPENAI_BASE_URL must be an https URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("BEDROCK_OPENAI_BASE_URL must be an https URL without credentials.");
  }
  return url.toString().replace(/\/+$/, "");
}

function openAIRoute(env: NodeJS.ProcessEnv): { apiKey: string; baseURL: string } {
  const apiKey = env.BEDROCK_API_KEY?.trim() || env.AWS_BEARER_TOKEN_BEDROCK?.trim() || "";
  if (!apiKey) {
    throw new Error("Bedrock OpenAI-compatible runtime requires BEDROCK_API_KEY or AWS_BEARER_TOKEN_BEDROCK.");
  }
  return { apiKey, baseURL: bedrockOpenAIBaseURL(env) };
}

/** Presence only. The AWS credential chain is not resolved and no request is sent. */
export function bedrockConfigured(env: NodeJS.ProcessEnv): boolean {
  try {
    if (bedrockRuntime(env) === "openai") { openAIRoute(env); return true; }
    bedrockRegion(env);
    return true;
  } catch { return false; }
}

const BEDROCK_STATIC_CREDENTIALS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;

export function bedrockEnvironment(env: NodeJS.ProcessEnv, secret?: string): NodeJS.ProcessEnv {
  const names = [...BEDROCK_TRANSPORT_ENVIRONMENT, ...BEDROCK_CREDENTIAL_ENVIRONMENT, ...BEDROCK_STATIC_CREDENTIALS];
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) picked[name] = value;
  }
  let runtime: BedrockRuntime = "converse";
  try { runtime = bedrockRuntime(picked); } catch { runtime = "converse"; }
  if (secret && runtime === "openai" && !picked.BEDROCK_API_KEY && !picked.AWS_BEARER_TOKEN_BEDROCK) {
    picked.BEDROCK_API_KEY = secret;
  }
  return picked;
}

export function createBedrockModel(model: string, env: NodeJS.ProcessEnv): LanguageModel {
  const runtime = bedrockRuntime(env);
  if (runtime === "openai") {
    const route = openAIRoute(env);
    return sanitizeBedrockModel(createBedrock({
      runtime: "openai",
      apiKey: route.apiKey,
      baseURL: route.baseURL
    })(model), [route.apiKey]);
  }
  const region = bedrockRegion(env);
  const bearer = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  const sessionToken = env.AWS_SESSION_TOKEN?.trim();
  // An explicit bearer selects token auth. A complete static key pair is passed
  // through when the process environment will not retain it. Otherwise the AWS
  // SDK default chain (roles, SSO, profile) applies. AWS_PROFILE is not passed.
  const staticCredentials = !bearer && accessKeyId && secretAccessKey
    ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
    : undefined;
  return sanitizeBedrockModel(createBedrock({
    region,
    ...(bearer ? { apiKey: bearer } : {}),
    ...(staticCredentials ? { credentials: staticCredentials } : {})
  })(model), [bearer, secretAccessKey, sessionToken].filter((value): value is string => Boolean(value)));
}

function sanitizeBedrockModel(model: LanguageModel, secrets: readonly string[]): LanguageModel {
  const clean = (error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      return new DOMException("Bedrock request cancelled.", "AbortError");
    }
    const record = error && typeof error === "object" ? error as { status?: unknown; retryable?: unknown } : {};
    const safe = new Error("Bedrock request failed. Check region, model access, and credentials.");
    if (typeof record.status === "number") Object.assign(safe, { status: record.status });
    if (typeof record.retryable === "boolean") Object.assign(safe, { retryable: record.retryable });
    for (const secret of secrets) {
      if (secret && safe.message.includes(secret)) safe.message = safe.message.split(secret).join("[REDACTED]");
    }
    return safe;
  };
  return wrapLanguageModel(model, [{
    name: "harness-bedrock-sanitized-errors",
    async wrapGenerate(_context, next) {
      try { return await next(); } catch (error) { throw clean(error); }
    },
    async wrapStream(_context, next) {
      let stream: AsyncIterable<StreamEvent>;
      try { stream = await next(); } catch (error) { throw clean(error); }
      return (async function* () {
        try {
          for await (const event of stream) {
            if (event.type === "error") throw clean(event.error);
            yield event;
          }
        } catch (error) { throw clean(error); }
      })();
    }
  }]);
}
