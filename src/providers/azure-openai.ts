import { createAzureOpenAI } from "@zhivex-ai/azure-openai";
import { wrapLanguageModel, type LanguageModel, type StreamEvent } from "@zhivex-ai/core";

/** Transport settings hashed into durable resumes. The API key is not included. */
export const AZURE_OPENAI_TRANSPORT_ENVIRONMENT = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENTS"
] as const;

const API_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export interface AzureOpenAIDeployment {
  readonly model: string;
}

export function azureOpenAIEndpoint(env: NodeJS.ProcessEnv): string {
  const value = env.AZURE_OPENAI_ENDPOINT?.trim() ?? "";
  if (!value) throw new Error("Azure OpenAI requires AZURE_OPENAI_ENDPOINT.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("AZURE_OPENAI_ENDPOINT must be an https URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("AZURE_OPENAI_ENDPOINT must be an https URL without credentials or a query.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function azureOpenAIApiVersion(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.AZURE_OPENAI_API_VERSION?.trim() ?? "";
  if (!value) return undefined;
  if (!API_VERSION.test(value)) throw new Error("AZURE_OPENAI_API_VERSION is invalid.");
  return value;
}

/** Accepts `{"deployment":"gpt-5.4"}` and `{"deployment":{"model":"gpt-5.4"}}`. */
export function azureOpenAIDeployments(env: NodeJS.ProcessEnv): Readonly<Record<string, AzureOpenAIDeployment>> {
  const raw = env.AZURE_OPENAI_DEPLOYMENTS?.trim() ?? "";
  if (!raw) return Object.freeze({});
  if (raw.length > 8192) throw new Error("AZURE_OPENAI_DEPLOYMENTS is too large.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("AZURE_OPENAI_DEPLOYMENTS must be a JSON object."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AZURE_OPENAI_DEPLOYMENTS must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  if (entries.length > 32) throw new Error("AZURE_OPENAI_DEPLOYMENTS lists too many deployments.");
  const deployments: Record<string, AzureOpenAIDeployment> = {};
  for (const [name, value] of entries) {
    if (!DEPLOYMENT_NAME.test(name)) throw new Error("AZURE_OPENAI_DEPLOYMENTS contains an invalid deployment name.");
    const model = typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value) && typeof (value as { model?: unknown }).model === "string"
        ? (value as { model: string }).model
        : "";
    const normalized = model.trim();
    if (!MODEL_ID.test(normalized)) throw new Error("AZURE_OPENAI_DEPLOYMENTS contains an invalid base model.");
    deployments[name] = Object.freeze({ model: normalized });
  }
  return Object.freeze(deployments);
}

/** Presence only. Does not contact Azure or check the key's account access. */
export function azureOpenAIConfigured(env: NodeJS.ProcessEnv): boolean {
  try {
    azureOpenAIEndpoint(env);
    azureOpenAIApiVersion(env);
    azureOpenAIDeployments(env);
    return Boolean(env.AZURE_OPENAI_API_KEY?.trim());
  } catch { return false; }
}

export function azureOpenAIEnvironment(env: NodeJS.ProcessEnv, secret?: string): NodeJS.ProcessEnv {
  const picked: Record<string, string> = {};
  for (const name of [...AZURE_OPENAI_TRANSPORT_ENVIRONMENT, "AZURE_OPENAI_API_KEY"] as const) {
    const value = env[name]?.trim();
    if (value) picked[name] = value;
  }
  if (secret && !picked.AZURE_OPENAI_API_KEY) picked.AZURE_OPENAI_API_KEY = secret;
  return picked;
}

export function createAzureOpenAIModel(model: string, env: NodeJS.ProcessEnv): LanguageModel {
  const endpoint = azureOpenAIEndpoint(env);
  const apiVersion = azureOpenAIApiVersion(env);
  const deployments = azureOpenAIDeployments(env);
  const apiKey = env.AZURE_OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing credentials for azure-openai. Set AZURE_OPENAI_API_KEY in the environment.");
  const settings = {
    apiKey,
    endpoint,
    ...(apiVersion ? { apiVersion } : {}),
    // Published 0.7.8 uses the base model for capabilities and request shape.
    // The deployment name remains the model id on the request.
    ...(Object.keys(deployments).length ? { deployments } : {})
  };
  // Published 0.7.8 reads AZURE_OPENAI_API_VERSION from process.env when the
  // option is omitted. Hide that fallback so the harness env is the only source.
  const azure = apiVersion
    ? createAzureOpenAI(settings)
    : withoutProcessEnv(["AZURE_OPENAI_API_VERSION"], () => createAzureOpenAI(settings));
  const deployed = sanitizeAzureModel(azure(model), apiKey);
  const baseModel = deployments[model]?.model;
  if (!baseModel || baseModel === model) return deployed;
  return withBaseModelCapabilities(deployed, azure(baseModel));
}

function withoutProcessEnv<T>(names: readonly string[], run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  try { return run(); }
  finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function withBaseModelCapabilities(deployed: LanguageModel, reference: LanguageModel): LanguageModel {
  return new Proxy(deployed, {
    get(target, property, receiver) {
      if (property === "capabilities") return reference.capabilities;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function sanitizeAzureModel(model: LanguageModel, secret: string): LanguageModel {
  const clean = (error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      return new DOMException("Azure OpenAI request cancelled.", "AbortError");
    }
    const record = error && typeof error === "object" ? error as { status?: unknown; retryable?: unknown } : {};
    const safe = new Error("Azure OpenAI request failed. Check the endpoint, deployment, and credentials.");
    if (secret && safe.message.includes(secret)) safe.message = safe.message.split(secret).join("[REDACTED]");
    if (typeof record.status === "number") Object.assign(safe, { status: record.status });
    if (typeof record.retryable === "boolean") Object.assign(safe, { retryable: record.retryable });
    return safe;
  };
  return wrapLanguageModel(model, [{
    name: "harness-azure-openai-sanitized-errors",
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
