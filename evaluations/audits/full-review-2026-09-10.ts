/** Offline audit probes. Only temporary fixtures and injected clients/models. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { McpClient, ModelMessage, ToolSet } from "@zhivex-ai/core";
import { createHarness, compactHarnessMessages } from "../../src/harness.js";
import { createHttpMcpClient, normalizeHarnessMcpConfiguration } from "../../src/mcp.js";

const root = await mkdtemp(join(tmpdir(), "zhx-full-review-"));
try {
  const collisions: Record<string, unknown>[] = [];
  for (const [prefix, suffix] of [["read_", "task"], ["repair_", "plan"], ["read_", "file"]]) {
    const client: McpClient = {
      async listTools() { return { tools: [{ name: suffix!, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }; },
      async callTool() { return { content: [{ type: "text", text: "injected fixture result" }] }; }
    };
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness({ workspace: root, projectContext: false,
        store: createInMemoryAgentRunStore(), modelInstance: createMockLanguageModel(), env: {},
        mcpConfiguration: { schemaVersion: 1, servers: [{ name: "fixture", transport: "custom",
          toolNamePrefix: prefix, includeTools: [suffix], permissions: ["read"], trustServerToolAnnotations: true }] },
        mcpClients: { fixture: client } });
      const name = prefix! + suffix!;
      const definition = (harness.agent.tools as ToolSet | undefined)?.[name];
      collisions.push({ name, accepted: true, metadata: definition?.metadata,
        result: definition && "execute" in definition ? await definition.execute({}) : null });
    } catch (error) { collisions.push({ name: prefix! + suffix!, accepted: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { await harness?.close(); }
  }
  const messages: ModelMessage[] = Array.from({ length: 20 }, (_, index) => ({ role: "user",
    parts: [{ type: "text", text: `Request ${index}: ${"ordinary task detail ".repeat(450)}` }] }));
  const compacted = compactHarnessMessages(messages);

  // The response to tools/list is followed by an unrelated JSON-RPC notification.
  // No network request is made: all HTTP responses are injected.
  const config = normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{ name: "fixture",
    transport: "http", url: "https://fixture.invalid/mcp", permissions: ["network"], includeTools: ["lookup"] }] });
  const responses = [
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }), { headers: { "content-type": "application/json" } }),
    new Response(null, { status: 202 }),
    new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n', { headers: { "content-type": "text/event-stream" } })
  ];
  let sse: unknown;
  try {
    const client = createHttpMcpClient(config.servers[0]!, {}, (async () => responses.shift()!) as unknown as typeof fetch);
    sse = { accepted: true, result: await client.listTools() };
  } catch (error) { sse = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }
  console.log(JSON.stringify({ networkCalls: 0, runtimeFilesChanged: false, collisions,
    manualCompaction: { inputCharacters: JSON.stringify(messages).length, outputCharacters: JSON.stringify(compacted).length,
      retainedFullRequests: compacted.length - 1 }, sse }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
