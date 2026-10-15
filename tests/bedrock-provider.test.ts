import { expect, test } from "bun:test";
import { BUILTIN_PROVIDER_REGISTRATIONS, createProviderRegistry, DEFAULT_PROVIDER_REGISTRY } from "../src/providers/providers.js";
import { BEDROCK_MATRIX_TIER, bedrockConfigured, createBedrockModel } from "../src/providers/bedrock.js";
import type { BedrockMockState } from "./preload-bedrock-mock.js";

const registry = DEFAULT_PROVIDER_REGISTRY;
const mockState = () => (globalThis as { __bedrockMock?: BedrockMockState }).__bedrockMock!;
const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }], maxRetries: 0 };
const agent = (model: { capabilities: unknown }) =>
  (model.capabilities as { reasoning?: boolean; agentCapabilities?: { supportTier?: string; approvalRequests?: boolean; toolChoiceNone?: boolean } });

test("Bedrock stays provisional and out of the empty transport fingerprint", () => {
  expect(BEDROCK_MATRIX_TIER).toEqual({ converse: "tier-b", openai: "tier-a" });
  expect(registry.descriptor("bedrock")).toMatchObject({
    support: "provisional",
    credentialNames: ["BEDROCK_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"]
  });
  expect(bedrockConfigured({})).toBe(false);
  expect(registry.availability({}).find((provider) => provider.id === "bedrock")?.configured).toBe(false);
  const previous = createProviderRegistry(BUILTIN_PROVIDER_REGISTRATIONS.filter((entry) => entry.descriptor.id !== "bedrock" && entry.descriptor.id !== "azure-openai"));
  expect(registry.transportFingerprint({})).toBe(previous.transportFingerprint({}));
  const env = { AWS_REGION: "us-east-1" };
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, AWS_REGION: "eu-west-1" }));
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, AWS_PROFILE: "fixture" }));
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, BEDROCK_RUNTIME: "openai" }));
  expect(registry.transportFingerprint(env)).toBe(registry.transportFingerprint({ ...env, BEDROCK_API_KEY: "fixture-key" }));
  expect(registry.transportFingerprint(env)).toBe(registry.transportFingerprint({ ...env, AWS_BEARER_TOKEN_BEDROCK: "fixture-bearer" }));
});

test("Converse uses the region and the AWS credential chain without a live call", async () => {
  const previous = process.env.AWS_REGION;
  process.env.AWS_REGION = "eu-central-1";
  try {
    const model = createBedrockModel("anthropic.claude-haiku-5-5", { AWS_DEFAULT_REGION: "us-west-2" });
    expect(mockState().config).toEqual({ region: "us-west-2" });
    expect(agent(model).reasoning).toBe(false);
    expect(agent(model).agentCapabilities).toMatchObject({ supportTier: "tier-c", approvalRequests: false, toolChoiceNone: false });
    const result = await model.generate(input);
    expect(result.text).toBe("ok");
    expect(mockState().commands[0]?.input).toMatchObject({ modelId: "anthropic.claude-haiku-5-5" });
    const stream = model.stream;
    if (!stream) throw new Error("Bedrock model does not expose stream.");
    const chunks = [];
    for await (const event of await stream(input)) chunks.push(event);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "text-delta", textDelta: "ok" }));
  } finally {
    if (previous === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous;
  }
});

test("an explicit bearer selects token auth and is removed from errors", async () => {
  const secret = "fixture-bearer-token";
  const model = createBedrockModel("amazon.nova-2-lite-v1:0", { AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: secret });
  expect(mockState().config).toEqual({ region: "us-east-1", token: { token: secret } });
  mockState().fail = `AccessDenied ${secret} account 123456789012`;
  try {
    await model.generate(input);
    throw new Error("expected Bedrock failure");
  } catch (error) {
    expect(String(error)).toContain("Bedrock request failed");
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("123456789012");
    expect(JSON.stringify(error)).not.toContain(secret);
  }
});

test("OpenAI-compatible Bedrock is Tier A and posts to the configured base URL", async () => {
  const secret = "fixture-bedrock-api-key";
  const original = globalThis.fetch;
  let seen: { url?: string; authorization?: string | null; model?: string } = {};
  globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen = { url: String(url), authorization: headers.get("authorization"), model: JSON.parse(String(init?.body)).model };
    if (headers.get("authorization") === `Bearer ${secret}-reject`) {
      return new Response(JSON.stringify({ error: secret }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return Response.json({
      id: "resp_fixture",
      status: "completed",
      output_text: "ok",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });
  }, { preconnect: original.preconnect });
  try {
    const model = createBedrockModel("anthropic.claude-haiku-5-5", {
      BEDROCK_RUNTIME: "openai",
      BEDROCK_API_KEY: secret,
      BEDROCK_OPENAI_BASE_URL: "https://bedrock-mantle.example/v1/"
    });
    expect(agent(model).agentCapabilities).toMatchObject({ supportTier: "tier-a", approvalRequests: true });
    expect((await model.generate(input)).text).toBe("ok");
    expect(seen.url).toBe("https://bedrock-mantle.example/v1/responses");
    expect(seen.authorization).toBe(`Bearer ${secret}`);
    expect(seen.model).toBe("anthropic.claude-haiku-5-5");
    const rejected = createBedrockModel("anthropic.claude-haiku-5-5", {
      BEDROCK_RUNTIME: "openai",
      BEDROCK_API_KEY: `${secret}-reject`,
      BEDROCK_OPENAI_BASE_URL: "https://bedrock-mantle.example/v1"
    });
    await expect(rejected.generate(input)).rejects.toThrow("Bedrock request failed");
    try { await rejected.generate(input); } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  } finally { globalThis.fetch = original; }
});

test("Bedrock route configuration rejects incomplete OpenAI settings and invalid regions", () => {
  expect(bedrockConfigured({ AWS_REGION: "us-east-1" })).toBe(true);
  expect(bedrockConfigured({ AWS_DEFAULT_REGION: "us-gov-west-1" })).toBe(true);
  expect(bedrockConfigured({ AWS_REGION: "not a region" })).toBe(false);
  expect(bedrockConfigured({ BEDROCK_RUNTIME: "openai", BEDROCK_API_KEY: "key" })).toBe(false);
  expect(bedrockConfigured({ BEDROCK_RUNTIME: "openai", BEDROCK_API_KEY: "key", BEDROCK_OPENAI_BASE_URL: "http://example.com" })).toBe(false);
  expect(bedrockConfigured({
    BEDROCK_RUNTIME: "openai",
    AWS_BEARER_TOKEN_BEDROCK: "key",
    BEDROCK_OPENAI_BASE_URL: "https://bedrock-mantle.example/v1"
  })).toBe(true);
  expect(() => createBedrockModel("anthropic.claude-haiku-5-5", { BEDROCK_RUNTIME: "mantle" })).toThrow("BEDROCK_RUNTIME");
});
