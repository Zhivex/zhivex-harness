import { expect, test } from "bun:test";
import { createHarnessMcpTools, createHttpMcpClient, normalizeHarnessMcpConfiguration, type HarnessMcpHttpOptions } from "../src/integrations/mcp.js";

const uri = "docs://architecture";
const config = (overrides: Record<string, unknown> = {}) => normalizeHarnessMcpConfiguration({ schemaVersion: 1,
  servers: [{ name: "sdk", transport: "http", protocolVersion: "2025-11-25", url: "https://mcp.example.test/rpc", includeTools: ["lookup"],
    includeResources: [uri], permissions: ["network", "read"], ...overrides }] });
const fixture = (http: HarnessMcpHttpOptions = {}, overrides: Record<string, unknown> = {}) => {
  const requests: { body: any; headers: Headers; url: string; redirect: RequestInit["redirect"] }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push({ body, headers: new Headers(init?.headers), url: String(input), redirect: init?.redirect });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} } } :
      body.method === "tools/list" ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } :
      body.method === "resources/list" ? { resources: [{ uri, name: "architecture" }] } :
      body.method === "resources/read" ? { contents: [{ uri, text: "Architecture evidence" }] } : { content: [{ type: "text", text: "result" }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: body.method === "initialize" ? { "mcp-session-id": "session" } : {} });
  }) as typeof fetch;
  const configuration = config(overrides);
  const client = createHttpMcpClient(configuration.servers[0]!, { ZHIVEX_MCP_SDK_KEY: "private-api-key" }, fetcher, http);
  return { client, configuration, requests, fetcher };
};

test("explicit SDK HTTP transport performs negotiation, typed resources and host token injection", async () => {
  const targets: string[] = [];
  const f = fixture({ auth: { getAccessToken: async request => { targets.push(request.resource); return "private-access-token"; } } },
    { headerEnv: { "x-api-key": "ZHIVEX_MCP_SDK_KEY" } });
  expect(await f.client.listTools()).toMatchObject({ tools: [{ name: "lookup" }] });
  expect(await f.client.readResource!({ uri })).toMatchObject({ contents: [{ uri }] });
  expect(f.requests.map(r => r.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "resources/read"]);
  expect(f.requests.every(r => r.redirect === "error" && r.url === "https://mcp.example.test/rpc")).toBe(true);
  expect(f.requests[2]!.headers.get("mcp-session-id")).toBe("session");
  expect(f.requests[2]!.headers.get("authorization")).toBe("Bearer private-access-token");
  expect(f.requests[2]!.headers.get("x-api-key")).toBe("private-api-key");
  expect(new Set(targets)).toEqual(new Set(["https://mcp.example.test/rpc"]));
});

test("SDK-backed resources retain harness allowlists, output checks and durable approval metadata", async () => {
  const f = fixture();
  const tools = await createHarnessMcpTools(f.configuration, { fetchImplementation: f.fetcher,
    httpOptions: { sdk: { auth: { getAccessToken: async () => "host-token" } } } });
  expect(tools.sdk_lookup).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
  const read = tools.sdk_read_resource!;
  expect(read).toMatchObject({ requiresApproval: true, approvalMode: "interrupt", metadata: { source: "mcp", untrustedContent: true } });
  if (!("execute" in read)) throw new Error("missing executable resource reader");
  expect(await read.execute({ uri })).toMatchObject({ untrustedContent: true, contents: [{ uri, text: "Architecture evidence" }] });
  const before = f.requests.length;
  await expect(f.client.readResource!({ uri: "docs://forbidden" })).rejects.toThrow("not allowed");
  expect(f.requests).toHaveLength(before);
});

test("SDK policy rejects destination before credentials/fetch and cannot permit loopback HTTP", async () => {
  let credentials = 0;
  const f = fixture({ destinationPolicy: async () => false, auth: { getAccessToken: async () => { credentials++; return "secret"; } } });
  await expect(f.client.listTools()).rejects.toThrow("DESTINATION_REJECTED");
  expect(credentials).toBe(0); expect(f.requests).toHaveLength(0);
  expect(() => config({ url: "http://127.0.0.1:8000/mcp" })).toThrow("requires HTTPS");
  expect(() => config({ protocolVersion: "unknown" })).toThrow();
  const legacy = config({ protocolVersion: "2025-06-18", url: "http://127.0.0.1:8000/mcp" });
  expect(() => createHttpMcpClient(legacy.servers[0]!, {}, f.fetcher, { auth: { getAccessToken: async () => "x" } })).toThrow("requires MCP protocolVersion");
});

test("host auth errors are sanitized and conflicting authorization channels fail before networking", async () => {
  const f = fixture({ auth: { getAccessToken: async () => { throw new Error("SECRET CREDENTIAL"); } } });
  try { await f.client.listTools(); throw new Error("Expected rejection"); }
  catch (error) { expect(String(error)).toContain("AUTH_REJECTED"); expect(String(error)).not.toContain("SECRET"); }
  expect(f.requests).toHaveLength(0);
  expect(() => fixture({ auth: { getAccessToken: async () => "token" } }, { headerEnv: { authorization: "ZHIVEX_MCP_SDK_KEY" } })).toThrow("cannot be combined");
});

test("SDK does not replay an indeterminate mutation or follow redirects", async () => {
  const f = fixture();
  let effects = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "tools/call") { effects++; throw new Error("REMOTE_SECRET connection dropped"); }
    return f.fetcher(input, init);
  }) as typeof fetch;
  const client = createHttpMcpClient(f.configuration.servers[0]!, {}, fetcher);
  await expect(client.callTool({ name: "lookup" })).rejects.toThrow("INDETERMINATE");
  expect(effects).toBe(1);
});

test("SDK initialization fetch is aborted when harness discovery deadline expires", async () => {
  let aborted = false, calls = 0;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
  }) as typeof fetch;
  const c = config({ listToolsTimeoutMs: 100 });
  const client = createHttpMcpClient(c.servers[0]!, {}, fetcher);
  await expect(client.listTools()).rejects.toThrow("transport failed");
  expect(aborted).toBe(true); expect(calls).toBe(1);
});

test("harness deadline retains indeterminate classification after tool dispatch", async () => {
  const f = fixture({}, { callToolTimeoutMs: 100 });
  let effects = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (JSON.parse(String(init?.body)).method !== "tools/call") return f.fetcher(input, init);
    effects++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted after effect")), { once: true }));
  }) as typeof fetch;
  const client = createHttpMcpClient(f.configuration.servers[0]!, {}, fetcher);
  await expect(client.callTool({ name: "lookup" })).rejects.toThrow("INDETERMINATE");
  expect(effects).toBe(1);
});
