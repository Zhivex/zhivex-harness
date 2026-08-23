import assert from "node:assert/strict";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createHarnessMcpTools,
  normalizeHarnessMcpConfiguration
} from "../src/mcp.js";

const authorization = "Bearer official-sdk-loopback-fixture";
let calls = 0;

const handler = createMcpHandler(() => {
  const server = new McpServer({
    name: "zhivex-official-sdk-interoperability",
    version: "1.0.0"
  }, { capabilities: { tools: {} } });
  server.registerTool(
    "lookup",
    {
      title: "Official SDK interoperability lookup",
      description: "Return bounded MCP TypeScript SDK interoperability evidence.",
      inputSchema: z.object({
        query: z.literal("release-readiness")
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ query }) => {
      calls += 1;
      return {
        content: [{
          type: "text" as const,
          text: `official-mcp-sdk-interoperability-ok:${query}`
        }]
      };
    }
  );
  return server;
});

const httpServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== authorization) {
      return new Response("unauthorized", { status: 401 });
    }
    return handler.fetch(request);
  }
});

try {
  const configuration = normalizeHarnessMcpConfiguration({
    schemaVersion: 1,
    servers: [{
      name: "official",
      transport: "http",
      url: `http://127.0.0.1:${httpServer.port}/mcp`,
      includeTools: ["lookup"],
      permissions: ["read", "network"],
      headerEnv: { authorization: "ZHIVEX_MCP_OFFICIAL_AUTH" },
      maxOutputBytes: 16 * 1024
    }]
  });
  const tools = await createHarnessMcpTools(configuration, {
    env: { ZHIVEX_MCP_OFFICIAL_AUTH: authorization }
  });
  const lookup = tools.official_lookup;
  assert(lookup && "execute" in lookup, "official SDK MCP lookup tool was not discovered");
  assert.equal(lookup.requiresApproval, true, "network MCP tool must require approval");
  assert.equal(lookup.approvalMode, "interrupt", "network MCP approval must interrupt");
  const result = await lookup.execute({ query: "release-readiness" });
  assert.deepEqual(result, {
    content: [{
      type: "text",
      text: "official-mcp-sdk-interoperability-ok:release-readiness"
    }]
  });
  assert.equal(calls, 1, "the official SDK tool must execute exactly once");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "official-mcp-sdk-interoperability",
    ok: true,
    certifiedAt: new Date().toISOString(),
    serverPackage: "@modelcontextprotocol/server",
    serverVersion: "2.0.0",
    clientProtocolVersion: "2025-06-18",
    serverCompatibilityMode: "legacy-stateless",
    transport: "loopback-streamable-http",
    toolCalls: calls
  }, null, 2)}\n`);
} finally {
  httpServer.stop(true);
}
