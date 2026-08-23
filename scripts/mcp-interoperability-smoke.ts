import assert from "node:assert/strict";

import {
  createHarnessMcpTools,
  normalizeHarnessMcpConfiguration
} from "../src/mcp.js";

const sessionId = "zhivex-controlled-session";
const authorization = "Bearer controlled-loopback-fixture";
const protocolVersion = "2025-06-18";
const observedMethods: string[] = [];

const response = (
  body: unknown,
  options: { status?: number; session?: boolean; eventStream?: boolean } = {}
) => new Response(
  options.eventStream
    ? `event: message\ndata: ${JSON.stringify(body)}\n\n`
    : body === undefined
      ? null
      : JSON.stringify(body),
  {
    status: options.status ?? 200,
    headers: {
      ...(options.eventStream
        ? { "content-type": "text/event-stream" }
        : body === undefined
          ? {}
          : { "content-type": "application/json" }),
      ...(options.session ? { "mcp-session-id": sessionId } : {})
    }
  }
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/mcp") {
      return response({ error: "not found" }, { status: 404 });
    }
    if (
      request.headers.get("authorization") !== authorization ||
      request.headers.get("mcp-protocol-version") !== protocolVersion ||
      !request.headers.get("accept")?.includes("text/event-stream")
    ) {
      return response({ error: "invalid transport headers" }, { status: 400 });
    }
    const payload = await request.json() as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: { query?: string } };
    };
    if (!payload.method) {
      return response({ error: "missing method" }, { status: 400 });
    }
    observedMethods.push(payload.method);

    if (payload.method === "initialize") {
      return response({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zhivex-controlled-mcp", version: "1.0.0" }
        }
      }, { session: true });
    }
    if (request.headers.get("mcp-session-id") !== sessionId) {
      return response({ error: "missing negotiated session" }, { status: 400 });
    }
    if (payload.method === "notifications/initialized") {
      return response(undefined, { status: 202, session: true });
    }
    if (payload.method === "tools/list") {
      return response({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{
            name: "lookup",
            description: "Return bounded controlled interoperability evidence.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false
            },
            annotations: { readOnlyHint: true }
          }]
        }
      }, { session: true, eventStream: true });
    }
    if (payload.method === "tools/call") {
      if (payload.params?.name !== "lookup" || payload.params.arguments?.query !== "release-readiness") {
        return response({
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32602, message: "invalid fixture arguments" }
        }, { session: true });
      }
      return response({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "controlled-mcp-interoperability-ok" }],
          structuredContent: { ok: true, transport: "streamable-http" }
        }
      }, { session: true });
    }
    return response({
      jsonrpc: "2.0",
      id: payload.id,
      error: { code: -32601, message: "method not found" }
    }, { session: true });
  }
});

try {
  const configuration = normalizeHarnessMcpConfiguration({
    schemaVersion: 1,
    servers: [{
      name: "controlled",
      transport: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
      includeTools: ["lookup"],
      permissions: ["read", "network"],
      headerEnv: { authorization: "ZHIVEX_MCP_CONTROLLED_AUTH" },
      maxOutputBytes: 16 * 1024
    }]
  });
  const tools = await createHarnessMcpTools(configuration, {
    env: { ZHIVEX_MCP_CONTROLLED_AUTH: authorization }
  });
  const lookup = tools.controlled_lookup;
  assert(lookup && "execute" in lookup, "controlled MCP lookup tool was not discovered");
  assert.equal(lookup.requiresApproval, true, "network MCP tool must require approval");
  assert.equal(lookup.approvalMode, "interrupt", "network MCP approval must interrupt");
  const result = await lookup.execute({ query: "release-readiness" });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "controlled-mcp-interoperability-ok" }],
    structuredContent: { ok: true, transport: "streamable-http" }
  });
  assert.deepEqual(observedMethods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call"
  ]);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "controlled-mcp-interoperability",
    ok: true,
    certifiedAt: new Date().toISOString(),
    protocolVersion,
    transport: "loopback-streamable-http",
    responseModes: ["application/json", "text/event-stream"],
    methods: observedMethods
  }, null, 2)}\n`);
} finally {
  server.stop(true);
}
