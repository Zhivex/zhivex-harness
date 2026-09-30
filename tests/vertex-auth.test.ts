import { expect, test } from "bun:test";
import { createVertexModel, vertexRoute, vertexTokenSource, VertexAuthenticationError } from "../src/providers/vertex-auth.js";

const env = { GOOGLE_CLOUD_PROJECT: "fixture-project", VERTEX_LOCATION: "us-central1" };

test("Vertex route is explicit and rejects resource/host injection without echoing identifiers", () => {
  expect(vertexRoute(env)).toEqual({ projectId: "fixture-project", location: "us-central1" });
  expect(vertexRoute({ ...env, VERTEX_LOCATION: "global" }).location).toBe("global");
  for (const input of [{}, { ...env, VERTEX_LOCATION: "" },
    { ...env, GOOGLE_CLOUD_PROJECT: "private/project" },
    { ...env, VERTEX_LOCATION: "private.example.com/path" }]) {
    expect(() => vertexRoute(input)).toThrow();
    try { vertexRoute(input); } catch (error) { expect(String(error)).not.toContain("private"); }
  }
});

test("ADC refresh is delegated for every request without retaining a token", async () => {
  let calls = 0;
  const token = vertexTokenSource({ ...env, GOOGLE_APPLICATION_CREDENTIALS: "/fixture/adc.json" }, vertexRoute(env), options => {
    expect(options).toEqual({ projectId: "fixture-project", keyFilename: "/fixture/adc.json", scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    return { async getAccessToken() { return `fixture-token-${++calls}`; } };
  });
  expect(await token()).toBe("fixture-token-1");
  expect(await token()).toBe("fixture-token-2");
});

test("ADC failure and missing tokens are sanitized without retaining the original cause", async () => {
  for (const getAccessToken of [async () => null, async (): Promise<string> => { throw new Error("private-user@example.com secret-token /private/adc.json"); }]) {
    const token = vertexTokenSource(env, vertexRoute(env), () => ({ getAccessToken }));
    try { await token(); throw new Error("Expected failure"); } catch (error) {
      expect(error).toBeInstanceOf(VertexAuthenticationError);
      expect(error).toMatchObject({ status: 401, retryable: false });
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toMatch(/private-user|secret-token|\/private/);
    }
  }
});

test("real Google ADC file acquisition failure is sanitized before leaving the host", async () => {
  const token = vertexTokenSource({ ...env, GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent-vertex-fixture/private-account-adc.json" }, vertexRoute(env));
  await expect(token()).rejects.toBeInstanceOf(VertexAuthenticationError);
});

test("real Vertex adapter uses the explicit route and fresh ADC callback despite ambient static credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.VERTEX_ACCESS_TOKEN;
  const originalKey = process.env.VERTEX_API_KEY;
  let refreshes = 0;
  const requests: { url: string; authorization: string | null }[] = [];
  process.env.VERTEX_ACCESS_TOKEN = "ambient-token-must-not-be-used";
  process.env.VERTEX_API_KEY = "ambient-key-must-not-be-used";
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "fixture response" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } });
  }, { preconnect: originalFetch.preconnect });
  try {
    const model = createVertexModel("gemini-2.5-flash", env, () => ({ async getAccessToken() { return `fixture-token-${++refreshes}`; } }));
    const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }] };
    await model.generate(input);
    await model.generate(input);
    expect(requests).toEqual([1, 2].map(n => ({ url: "https://us-central1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent", authorization: `Bearer fixture-token-${n}` })));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.VERTEX_ACCESS_TOKEN; else process.env.VERTEX_ACCESS_TOKEN = originalToken;
    if (originalKey === undefined) delete process.env.VERTEX_API_KEY; else process.env.VERTEX_API_KEY = originalKey;
  }
});
