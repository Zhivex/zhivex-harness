import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { credentialModel, CliCredentials, type CredentialInput, type SecretEntry } from "../src/cli/cli-credentials.js";
import { ConsoleInput } from "../src/cli/console/console-input.js";

function fixture(environment: NodeJS.ProcessEnv = {}) {
  const keys = new Map<string, string>();
  let accesses = 0, output = "";
  const store = new CliCredentials(async provider => {
    accesses++;
    return {
      getPassword: async () => keys.get(provider),
      setPassword: async value => { keys.set(provider, value); },
      deleteCredential: async () => keys.delete(provider),
    } satisfies SecretEntry;
  }, environment, text => { output += text; });
  const ui = (answers: unknown[], secret = "opaque-test-key") => ({
    select: async () => answers.shift(), secret: async () => secret,
  }) as CredentialInput;
  return { keys, store, ui, accesses: () => accesses, output: () => output };
}

test("environment aliases win without touching the keychain or global environment", async () => {
  const f = fixture({ QWEN_API_KEY: "environment-key" });
  f.keys.set("qwen", "stored-key");
  const resolved = await f.store.providerEnvironment("qwen", f.ui([]));
  expect(resolved.QWEN_API_KEY).toBe("environment-key");
  expect(f.accesses()).toBe(0);
  expect(resolved.DASHSCOPE_API_KEY).toBeUndefined();
});

test("temporary keys stay out of persistent storage and provider accounts remain separate", async () => {
  const f = fixture();
  await f.store.configure("openai", f.ui(["temporary"]));
  expect((await f.store.providerEnvironment("openai", f.ui([]))).OPENAI_API_KEY).toBe("opaque-test-key");
  expect(f.keys.size).toBe(0);
  await f.store.configure("qwen", f.ui(["save"], "qwen-key"));
  expect(f.keys.get("qwen")).toBe("qwen-key");
  expect(f.keys.has("openai")).toBe(false);
  expect(f.output()).not.toContain("opaque-test-key");
  expect(f.output()).not.toContain("qwen-key");
  f.store.clear();
  await expect(f.store.providerEnvironment("openai", f.ui(["cancel"]))).rejects.toThrow("cancelled");
});

test("saved keys survive session replacement and removal requires a separate choice", async () => {
  const f = fixture();
  await f.store.configure("openai", f.ui(["save"], "first-key"));
  f.store.clear();
  expect((await f.store.providerEnvironment("openai", f.ui([]))).OPENAI_API_KEY).toBe("first-key");
  await f.store.configure("openai", f.ui(["save"], "replacement-key"));
  await f.store.configure("openai", f.ui(["delete", false]));
  expect(f.keys.get("openai")).toBe("replacement-key");
  await f.store.configure("openai", f.ui(["delete", true]));
  expect(f.keys.size).toBe(0);
});

test("native missing-key null is treated as absence", async () => {
  const store = new CliCredentials(async () => ({getPassword:async()=>null,setPassword:async()=>{},deleteCredential:async()=>false}), {}, () => {});
  await expect(store.providerEnvironment("openai", fixture().ui(["cancel"]))).rejects.toThrow("cancelled");
});

test("unavailable storage never saves elsewhere and cannot leak backend errors", async () => {
  let output = "", asked = false;
  const store = new CliCredentials(async () => { throw new Error("sensitive backend detail"); }, {}, text => { output += text; });
  const choices = ["save", "cancel"];
  const ui = { select: async () => choices.shift(), secret: async () => { asked = true; return "key"; } } as CredentialInput;
  expect(await store.configure("openai", ui)).toBe(false);
  expect(asked).toBe(false);
  expect(output).not.toContain("sensitive");
});

test("managed keys cannot be redirected by endpoint overrides; environment keys remain explicit", async () => {
  const f = fixture({ OPENAI_BASE_URL: "https://untrusted.example" });
  f.keys.set("openai", "stored-key");
  await expect(f.store.providerEnvironment("openai", f.ui([]))).rejects.toThrow("default endpoint");
  expect(f.accesses()).toBe(0);
});

test("hidden input never echoes, enters prompt history, or forwards surplus answers", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let rendered = ""; output.on("data", chunk => { rendered += chunk.toString(); });
  const console = new ConsoleInput(input, output, true);
  try {
    const key = console.secret("API key: ");
    input.write("\x1b[200~opaque-private-key\x1b[201~");
    let done = false; void key.then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(done).toBe(false);
    input.write("\r/approve\n");
    expect(await key).toBe("opaque-private-key");
    const next = console.question("> ", true);
    input.write("\x1b[A");
    input.write("safe\n");
    expect(await next).toBe("safe");
    expect(rendered).not.toContain("opaque-private-key");
    expect(rendered).not.toContain("/approve");
  } finally { console.close(); }
});

test("hidden input cancels controls, multiline paste, overflow and close without leaking", async () => {
  for (const payload of ["key\x03", "\x1b[200~key\nsecond\x1b[201~", "x".repeat(8193)]) {
    const input = new PassThrough(), output = new PassThrough();
    const console = new ConsoleInput(input, output, true);
    try {
      const result = console.secret("Key: ");
      const outcome = result.then(() => undefined, error => error);
      input.write(payload);
      expect((await outcome)?.message).toContain("interrupted");
    } finally { console.close(); }
  }
});


test("provider exceptions are scrubbed before generation and stream errors escape", async () => {
  const secret = "opaque-provider-secret";
  const underlying = {
    provider: "openai", modelId: "fixture",
    generate: async () => { throw new Error(`request failed: ${secret}`, {cause: {authorization:secret}}); },
    stream: async function* () { throw new Error(`stream failed: ${secret}`, {cause: {authorization:secret}}); },
  } as unknown as ReturnType<typeof import("../src/runtime/config.js").createProviderModel>;
  const model = await credentialModel({provider:"openai",model:"fixture"}, {OPENAI_API_KEY:secret}, () => underlying);
  try { await model.generate({messages:[]}); throw new Error("expected failure"); }
  catch (error) { expect(String(error)).toContain("[REDACTED]"); expect(String(error)).not.toContain(secret); expect((error as Error).cause).toBeUndefined(); }
  try { for await (const _ of await model.stream!({messages:[]})) {} throw new Error("expected failure"); }
  catch (error) { expect(String(error)).toContain("[REDACTED]"); expect(String(error)).not.toContain(secret); expect((error as Error).cause).toBeUndefined(); }
});


test("failed keychain writes recover explicitly to a temporary key without leaking secrets", async () => {
  let output = "";
  const store = new CliCredentials(async () => ({
    getPassword: async () => null,
    setPassword: async () => { throw new Error("private-backend-secret"); },
    deleteCredential: async () => false,
  }), {}, text => { output += text; });
  expect(await store.configure("qwen", fixture().ui(["save", "temporary"], "private-key"))).toBe(true);
  expect(await store.inspect("qwen")).toEqual({ source: "temporary", configured: true });
  expect((await store.providerEnvironment("qwen", fixture().ui([]))).DASHSCOPE_API_KEY).toBe("private-key");
  expect(store.source("qwen")).toBe("temporary");
  expect(output).not.toContain("private-key");
  expect(output).not.toContain("private-backend-secret");
});

test("credential inspection distinguishes missing, saved, environment and blocked keys", async () => {
  const f = fixture();
  expect(await f.store.inspect("openai")).toEqual({ source: "missing", configured: false });
  f.keys.set("openai", "saved-key");
  expect(await f.store.inspect("openai")).toEqual({ source: "keychain", configured: true });
  const env = fixture({ OPENAI_API_KEY: "env-key" });
  expect(await env.store.inspect("openai")).toEqual({ source: "environment", configured: true });
  expect(env.accesses()).toBe(0);
  const blocked = fixture({ OPENAI_BASE_URL: "https://example.com" });
  expect(await blocked.store.inspect("openai")).toEqual({ source: "blocked", configured: false });
  expect(blocked.accesses()).toBe(0);
});


test("keychain setup can retry after unlock without changing storage mode", async () => {
  let attempts = 0, saved = "";
  const store = new CliCredentials(async () => {
    if (++attempts === 1) throw new Error("locked");
    return { getPassword: async () => saved, setPassword: async value => { saved = value; }, deleteCredential: async () => false };
  }, {}, () => {});
  expect(await store.configure("openai", fixture().ui(["save", "retry", "save"], "retry-key"))).toBe(true);
  expect(saved).toBe("retry-key");
  expect(await store.inspect("openai")).toEqual({ source: "keychain", configured: true });
});
