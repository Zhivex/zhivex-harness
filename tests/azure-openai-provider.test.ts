import { expect, test } from "bun:test";
import { BUILTIN_PROVIDER_REGISTRATIONS, createProviderRegistry, DEFAULT_PROVIDER_REGISTRY } from "../src/providers/providers.js";
import { azureOpenAIConfigured, createAzureOpenAIModel } from "../src/providers/azure-openai.js";

const registry = DEFAULT_PROVIDER_REGISTRY;
const secret = "fixture-azure-api-key";
const endpoint = "https://example.openai.azure.com";
const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }], maxRetries: 0 };
const chat = {
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};
const agent = (model: { capabilities: unknown }) =>
  (model.capabilities as { agentCapabilities?: { supportTier?: string; toolSearch?: boolean } }).agentCapabilities;

test("Azure OpenAI stays provisional and out of the empty transport fingerprint", () => {
  expect(registry.descriptor("azure-openai")).toMatchObject({
    support: "provisional",
    credentialNames: ["AZURE_OPENAI_API_KEY"],
    defaultModel: "gpt-5.4"
  });
  expect(azureOpenAIConfigured({})).toBe(false);
  const previous = createProviderRegistry(BUILTIN_PROVIDER_REGISTRATIONS.filter((entry) => entry.descriptor.id !== "bedrock" && entry.descriptor.id !== "azure-openai"));
  expect(registry.transportFingerprint({})).toBe(previous.transportFingerprint({}));
  const env = { AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_KEY: secret };
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, AZURE_OPENAI_ENDPOINT: "https://other.openai.azure.com" }));
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, AZURE_OPENAI_API_VERSION: "2024-10-21" }));
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, AZURE_OPENAI_DEPLOYMENTS: "{\"chat\":\"gpt-5.4\"}" }));
  expect(registry.transportFingerprint(env)).toBe(registry.transportFingerprint({ ...env, AZURE_OPENAI_API_KEY: "other-key" }));
  expect(registry.transportFingerprint({ AZURE_OPENAI_API_VERSION: "2024-10-21" })).toBe(registry.transportFingerprint({}));
  expect(registry.transportFingerprint({ AZURE_OPENAI_DEPLOYMENTS: "{\"chat\":\"gpt-5.4\"}" })).toBe(registry.transportFingerprint({}));
  expect(registry.transportFingerprint({ AZURE_OPENAI_ENDPOINT: endpoint })).toBe(registry.transportFingerprint({}));
});

test("deployment chat completions omit the model and keep the API key out of errors", async () => {
  const original = globalThis.fetch;
  const ambient = process.env.AZURE_OPENAI_API_VERSION;
  process.env.AZURE_OPENAI_API_VERSION = "2099-01-01";
  let seen: { url?: string; apiKey?: string | null; model?: unknown } = {};
  globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    seen = { url: String(url), apiKey: headers.get("api-key"), model: body.model };
    if (headers.get("api-key") === `${secret}-reject`) {
      return new Response(JSON.stringify({ error: { message: secret } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return Response.json(chat);
  }, { preconnect: original.preconnect });
  try {
    const model = createAzureOpenAIModel("gpt-5.4", {
      AZURE_OPENAI_API_KEY: secret,
      AZURE_OPENAI_ENDPOINT: `${endpoint}/`,
      AZURE_OPENAI_API_VERSION: "2024-10-21"
    });
    expect(model.provider).toBe("azure-openai");
    expect(model.modelId).toBe("gpt-5.4");
    expect(agent(model)?.supportTier).toBe("tier-a");
    expect((await model.generate(input)).text).toBe("ok");
    expect(seen.url).toContain("/openai/deployments/gpt-5.4/chat/completions?api-version=2024-10-21");
    expect(seen.url).not.toContain("2099-01-01");
    expect(seen.apiKey).toBe(secret);
    expect(seen.model).toBeUndefined();
    const rejected = createAzureOpenAIModel("gpt-5.4", {
      AZURE_OPENAI_API_KEY: `${secret}-reject`,
      AZURE_OPENAI_ENDPOINT: endpoint,
      AZURE_OPENAI_API_VERSION: "2024-10-21"
    });
    await expect(rejected.generate(input)).rejects.toThrow(/Azure OpenAI request failed/);
    try { await rejected.generate(input); } catch (error) {
      const record = error as { status?: number; message?: string };
      expect(record.status).toBe(401);
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  } finally {
    globalThis.fetch = original;
    if (ambient === undefined) delete process.env.AZURE_OPENAI_API_VERSION;
    else process.env.AZURE_OPENAI_API_VERSION = ambient;
  }
});

test("a deployment map overlays base-model capabilities and still calls the deployment", async () => {
  const original = globalThis.fetch;
  let url = "";
  globalThis.fetch = Object.assign(async (request: string | URL | Request) => {
    url = String(request);
    return Response.json(chat);
  }, { preconnect: original.preconnect });
  try {
    const mapped = createAzureOpenAIModel("contoso-chat", {
      AZURE_OPENAI_API_KEY: secret,
      AZURE_OPENAI_ENDPOINT: endpoint,
      AZURE_OPENAI_API_VERSION: "2024-10-21",
      AZURE_OPENAI_DEPLOYMENTS: JSON.stringify({ "contoso-chat": { model: "gpt-5.4" } })
    });
    expect(mapped.modelId).toBe("contoso-chat");
    expect(agent(mapped)?.toolSearch).toBe(true);
    expect((await mapped.generate(input)).text).toBe("ok");
    expect(url).toContain("/openai/deployments/contoso-chat/chat/completions");
    const opaque = createAzureOpenAIModel("contoso-chat", {
      AZURE_OPENAI_API_KEY: secret,
      AZURE_OPENAI_ENDPOINT: endpoint,
      AZURE_OPENAI_API_VERSION: "2024-10-21"
    });
    expect(opaque.modelId).toBe("contoso-chat");
    expect(agent(opaque)?.toolSearch).toBe(false);
  } finally { globalThis.fetch = original; }
});

test("Azure OpenAI configuration rejects missing and unsafe routes", () => {
  expect(azureOpenAIConfigured({ AZURE_OPENAI_API_KEY: secret, AZURE_OPENAI_ENDPOINT: endpoint })).toBe(true);
  expect(azureOpenAIConfigured({ AZURE_OPENAI_ENDPOINT: endpoint })).toBe(false);
  expect(azureOpenAIConfigured({ AZURE_OPENAI_API_KEY: secret, AZURE_OPENAI_ENDPOINT: "http://example.openai.azure.com" })).toBe(false);
  expect(azureOpenAIConfigured({ AZURE_OPENAI_API_KEY: secret, AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_VERSION: "bad version" })).toBe(false);
  expect(azureOpenAIConfigured({
    AZURE_OPENAI_API_KEY: secret,
    AZURE_OPENAI_ENDPOINT: endpoint,
    AZURE_OPENAI_DEPLOYMENTS: "{\"chat\":\"gpt-5.4\"}"
  })).toBe(true);
  expect(() => createAzureOpenAIModel("gpt-5.4", { AZURE_OPENAI_API_KEY: secret })).toThrow("AZURE_OPENAI_ENDPOINT");
});
