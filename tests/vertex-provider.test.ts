import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PROVIDER_REGISTRY as registry, BUILTIN_PROVIDER_REGISTRATIONS, createProviderRegistry } from "../src/providers/providers.js";
import { createVertexModel } from "../src/providers/vertex-auth.js";
import { createHarness, runHarness } from "../src/runtime/harness.js";

const env = { GOOGLE_CLOUD_PROJECT: "fixture-project", VERTEX_LOCATION: "global" };
// A model accepted by the SDK on both fixture routes, to reach the resume guard.
const modelId = "gemini-2.5-flash";

test("Vertex registration is provisional, presence-only and preserves existing unconfigured bindings", () => {
  expect(registry.descriptor("vertex")).toMatchObject({ support: "provisional", credentialNames: [] });
  expect(registry.availability({}).find(p => p.id === "vertex")?.configured).toBe(false);
  const availability = registry.availability(env).find(p => p.id === "vertex");
  expect(availability?.configured).toBe(true);
  expect(JSON.stringify(availability)).not.toContain("fixture-project");
  const previous = createProviderRegistry(BUILTIN_PROVIDER_REGISTRATIONS.filter(p => p.descriptor.id !== "vertex"));
  expect(registry.transportFingerprint({})).toBe(previous.transportFingerprint({}));
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, VERTEX_LOCATION: "us-central1" }));
  expect(registry.transportFingerprint(env)).not.toBe(registry.transportFingerprint({ ...env, GOOGLE_CLOUD_PROJECT: "second-project" }));
  expect(registry.transportFingerprint(env)).toBe(registry.transportFingerprint({ ...env, VERTEX_ACCESS_TOKEN: "ignored" }));
});

for (const change of ["none", "project", "location"] as const) test(`Vertex streaming approval survives reopen only on the same route: ${change}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhx-vertex-durable-"));
  const original = globalThis.fetch;
  const bodies: any[] = [];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const part = bodies.length === 1 ? {
      functionCall: { id: "vertex-edit", name: "apply_reviewed_edits", args: { changes: [{ path: "target.txt", content: "after\n", expectedDigest: null }] } },
      thoughtSignature: "vertex-signature"
    } : { text: "done" };
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`);
  }, { preconnect: original.preconnect });
  const options = (environment: NodeJS.ProcessEnv) => ({ provider: "vertex", model: modelId, workspace: root, env: environment, projectContext: false,
    modelInstance: createVertexModel(modelId, environment, () => ({ async getAccessToken() { return "fixture-token"; } })) });
  try {
    harness = await createHarness(options(env));
    const waiting = await runHarness(harness, { prompt: "Create target.txt" });
    expect(waiting.status).toBe("waiting_approval");
    await expect(readFile(path.join(root, "target.txt"))).rejects.toThrow();
    const runId = waiting.state.runId;
    await harness.close();
    const next = change === "project" ? { ...env, GOOGLE_CLOUD_PROJECT: "second-project" }
      : change === "location" ? { ...env, VERTEX_LOCATION: "us-central1" } : env;
    harness = await createHarness(options(next));
    const state = await harness.store.load(runId, harness.config.scope);
    expect(state).not.toBeNull();
    const resume = () => runHarness(harness!, { state: state!, approvals: state!.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
    if (change === "none") {
      const result = await resume();
      expect(result.status).toBe("completed");
      expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("after\n");
      const parts = bodies[1].contents.flatMap((m: any) => m.parts);
      expect(parts).toContainEqual(expect.objectContaining({ thoughtSignature: "vertex-signature" }));
      expect(parts).toContainEqual(expect.objectContaining({ functionResponse: expect.objectContaining({ id: "vertex-edit" }) }));
    } else {
      await expect(resume()).rejects.toThrow(/harness|fingerprint|binding/i);
      await expect(readFile(path.join(root, "target.txt"))).rejects.toThrow();
      expect(bodies).toHaveLength(1);
    }
  } finally { globalThis.fetch = original; await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Vertex provider errors preserve diagnosis without response payloads or customer identity", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "private-account@example.com secret-token" } }, { status: 403 }), { preconnect: original.preconnect });
  try {
    const model = createVertexModel(modelId, env, () => ({ async getAccessToken() { return "fixture-token"; } }));
    try { await model.generate({ messages: [] }); throw new Error("Expected failure"); } catch (error) {
      expect(error).toMatchObject({ status: 403, provider: { reason: "permission" } });
      expect(JSON.stringify(error)).not.toMatch(/private-account|secret-token/);
      expect((error as Error).cause).toBeUndefined();
    }
  } finally { globalThis.fetch = original; }
});

const retryNow = { attempts: 3, delayMs: () => 0 };
const token = () => ({ async getAccessToken() { return "fixture-token"; } });
const stopped = (parts: unknown[]) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
});

test("Vertex retries a transient 409 and preserves the ABORTED category without the payload", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls += 1;
    if (calls < 2) return Response.json({ error: { code: 409, status: "ABORTED", message: "private-account@example.com secret-token" } }, { status: 409 });
    return Response.json(stopped([{ text: "ok" }]));
  }, { preconnect: original.preconnect });
  try {
    const model = createVertexModel(modelId, env, token, retryNow);
    const result = await model.generate({ messages: [] });
    expect(result.text).toBe("ok");
    expect(calls).toBe(2);
  } finally { globalThis.fetch = original; }
});

test("Vertex exhausts bounded retries for a persistent 409 and reports a retryable provider failure", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls += 1;
    return Response.json({ error: { code: 409, status: "ABORTED", message: "private-account@example.com secret-token" } }, { status: 409 });
  }, { preconnect: original.preconnect });
  try {
    const model = createVertexModel(modelId, env, token, retryNow);
    try { await model.generate({ messages: [] }); throw new Error("Expected failure"); } catch (error) {
      expect(error).toMatchObject({ status: 409, providerStatus: "ABORTED", retryable: true, provider: { reason: "server_error" } });
      expect(JSON.stringify(error)).not.toMatch(/private-account|secret-token/);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(calls).toBe(3);
  } finally { globalThis.fetch = original; }
});

test("Vertex retries a gRPC ABORTED Google error and a stream reset", async () => {
  const original = globalThis.fetch;
  for (const failure of [
    Object.assign(new Error("projects/secret-project"), { code: 10, httpStatusCode: 409 }),
    Object.assign(new Error("secret-token"), { code: "ECONNRESET" })
  ]) {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return Response.json(stopped([{ text: "ok" }]));
    }, { preconnect: original.preconnect });
    const model = createVertexModel(modelId, env, token, retryNow);
    const result = await model.generate({ messages: [] });
    expect(result.text).toBe("ok");
    expect(calls).toBe(2);
  }
  globalThis.fetch = original;
});

test("Vertex retries an empty model turn and returns it after the budget", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls += 1;
    if (calls === 1) return Response.json(stopped([]));
    if (calls === 2) return Response.json(stopped([{ thought: true }]));
    return Response.json(stopped([{ text: "ok" }]));
  }, { preconnect: original.preconnect });
  try {
    const model = createVertexModel(modelId, env, token, retryNow);
    expect((await model.generate({ messages: [] })).text).toBe("ok");
    expect(calls).toBe(3);
    calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      return Response.json(stopped([]));
    }, { preconnect: original.preconnect });
    const emptyModel = createVertexModel(modelId, env, token, retryNow);
    const empty = await emptyModel.generate({ messages: [] });
    expect(empty.text ?? "").toBe("");
    expect(calls).toBe(3);
  } finally { globalThis.fetch = original; }
});

test("Vertex does not retry a permission failure, visible thought text, or a content filter", async () => {
  const original = globalThis.fetch;
  const cases = [
    Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "private-account@example.com secret-token" } }, { status: 403 }),
    Response.json(stopped([{ thought: true, text: "visible" }])),
    Response.json({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] })
  ];
  try {
    for (const response of cases) {
      let calls = 0;
      globalThis.fetch = Object.assign(async () => {
        calls += 1;
        return response.clone();
      }, { preconnect: original.preconnect });
      const model = createVertexModel(modelId, env, token, retryNow);
      try { await model.generate({ messages: [] }); } catch (error) {
        expect(JSON.stringify(error)).not.toMatch(/private-account|secret-token/);
        expect((error as { status?: number }).status).not.toBe(409);
      }
      expect(calls).toBe(1);
    }
  } finally { globalThis.fetch = original; }
});

test("Vertex stream retries a truncated stream before the caller observes it", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("secret-token"), { code: "ECONNRESET" });
    return new Response(`data: ${JSON.stringify(stopped([{ text: "streamed" }]))}\n\n`);
  }, { preconnect: original.preconnect });
  try {
    const model = createVertexModel(modelId, env, token, retryNow);
    const events = [];
    for await (const event of await model.stream!({ messages: [] })) events.push(event);
    expect(events.some(event => event.type === "text-delta" && event.textDelta.includes("streamed"))).toBe(true);
    expect(calls).toBe(2);
  } finally { globalThis.fetch = original; }
});

test("cancelling Vertex while ADC acquisition is pending does not wait for credentials", async () => {
  const model = createVertexModel(modelId, env, () => ({ getAccessToken: () => new Promise<string>(() => {}) }));
  const controller = new AbortController();
  const pending = model.generate({ messages: [], abortSignal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
}, 1000);
