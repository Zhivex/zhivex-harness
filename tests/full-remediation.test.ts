import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { JsonValue, ModelMessage, ToolSet } from "@zhivex-ai/core";
import { createHarness, runHarness, compactHarnessMessages } from "../src/harness.js";
import { createModelBudget, MODEL_BUDGET_KEY } from "../src/model-budget.js";
import { REPAIR_CONTROLLER_KEY } from "../src/repair-controller.js";
import { inspectHarnessRun } from "../src/operations.js";
import { RUNTIME_DIAGNOSTICS_KEY } from "../src/runtime-checkpoints.js";
import { createHttpMcpClient, normalizeHarnessMcpConfiguration } from "../src/mcp.js";
import type { HarnessOciRuntimeAdapter } from "../src/execution-environment.js";

for (const [prefix, name] of [["read_", "task"], ["repair_", "plan"], ["read_", "file"], ["run_environment_", "command"], ["load_", "skill"]] as const) {
  test(`rejects reserved MCP name ${prefix}${name}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhx-collision-"));
    try { await expect(createHarness({ workspace: root, modelInstance: createMockLanguageModel(), store: createInMemoryAgentRunStore(),
      mcpConfiguration: { schemaVersion: 1, servers: [{ name: "fixture", transport: "custom", permissions: ["read"], includeTools: [name], toolNamePrefix: prefix }] },
      mcpClients: { fixture: { async listTools() { return { tools: [{ name, inputSchema: { type: "object" } }] }; }, async callTool() { throw new Error("Must not execute"); } } }
    })).rejects.toThrow("conflicts"); } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("manual compaction bounds long requests while run metadata retains full requirements", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhx-compact-"));
  const messages: ModelMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: "user", parts: [{ type: "text", text: `Task ${i}: ${"detail ".repeat(1000)} final criterion ${i}` }] }));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const compacted = compactHarnessMessages(messages);
    expect(JSON.stringify(compacted).length).toBeLessThan(5000);
    harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: "finish", finishReason: "stop" }]] }), store: createInMemoryAgentRunStore() });
    const result = await runHarness(harness, { messages: compacted });
    expect(JSON.stringify(result.state.metadata?.zhivexTaskSources)).toContain("final criterion 19");
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test("work cannot spend the closure reserve and snapshots retain complete accounting", async () => {
  let closing = false;
  const budget = createModelBudget({ inputTokens: 1000, outputTokens: 1000 }, { closure: () => closing });
  const context = { input: { messages: [] }, model: createMockLanguageModel() };
  budget.stats.inputTokens = 680;
  await expect(budget.middleware.wrapGenerate!(context, async () => ({ usage: { inputTokens: 10, outputTokens: 1 } }))).rejects.toThrow("WORK_TOKEN_BUDGET");
  expect(budget.stats.inputTokens).toBe(680);
  closing = true;
  await budget.middleware.wrapGenerate!(context, async () => ({ usage: { inputTokens: 10, outputTokens: 1 } }));
  const restored = createModelBudget({ inputTokens: 1000, outputTokens: 1000 }, { saved: budget.snapshot() });
  expect(restored.stats.inputTokens).toBe(690);
  const unknown = createModelBudget({ inputTokens: 1000, outputTokens: 1000 }, { saved: { ...budget.snapshot(), inFlight: true } });
  await expect(unknown.middleware.wrapGenerate!(context, async () => ({}))).rejects.toThrow("USAGE_UNAVAILABLE");
});

for (const scenario of ["approve", "deny", "resume", "failed-recovered", "cancelled"] as const) {
  test(`controller delivers an early candidate without another provider decision: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhx-controller-"));
    const store = createInMemoryAgentRunStore();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    let calls = 0, commands = 0;
    const runtime: HarnessOciRuntimeAdapter = {
      async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference,
        imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
      async run(request) { commands++; return { command: request.command, exitCode: scenario === "cancelled" ? 130 : scenario === "failed-recovered" && commands === 1 ? 4 : 0, stdout: "", stderr: "", timedOut: false, cancelled: scenario === "cancelled", outputLimitExceeded: false }; },
      async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
    };
    const finish = { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 10, outputTokens: 2 } };
    const call = (name: string, input: JsonValue) => ({ type: "tool-call" as const, toolCall: { id: name, name, input } });
    const model = createMockLanguageModel({ streamEvents: [
      [call("repair_plan", { hypothesis: "Create the required file", expectedBehavior: "file contains after", paths: ["value.txt"], nextCheck: "check the fixture", verifier: { command: "node", args: ["verify.mjs"], purpose: "assert file content" } }), finish],
      [call("apply_reviewed_edits", { changes: [{ path: "value.txt", expectedDigest: null, content: "after\n" }] }), finish],
      [call("repair_plan", { hypothesis: "Correct verifier after the failed check", expectedBehavior: "file contains after", paths: ["value.txt"], nextCheck: "corrected assertion", verifier: { command: "node", args: ["verify-corrected.mjs"], purpose: "assert required file content" } }), finish]
    ] });
    const stream = model.stream!; model.stream = input => { calls++; return stream(input); };
    try {
      harness = await createHarness({ workspace: root, executionBackend: "oci", agentProfile: "repair", modelInstance: model,
        store, ociRuntimeAdapter: runtime, ociAllowedCommands: ["node", "bun"], maxSteps: 8 });
      const result = await runHarness(harness, { runId: "controller", scope: harness.config.scope, prompt: "Create value.txt with after and verify it." }, {
        resolveApprovals: async pending => pending[0]?.name.startsWith("verify_") && scenario === "resume" ? undefined : pending.map(a => ({ provider: a.provider,
          approvalRequestId: a.id, approve: scenario !== "deny" || !a.name.startsWith("verify_") }))
      }).catch(error => { if (scenario !== "deny" && scenario !== "cancelled") throw error; return undefined; });
      if (scenario === "deny" || scenario === "cancelled") {
        expect(result?.status).not.toBe("completed"); expect(commands).toBe(scenario === "deny" ? 0 : 1);
        await expect(readFile(path.join(root, "value.txt"), "utf8")).rejects.toThrow();
      }
      else {
        if (!result) throw new Error("Missing result");
        const completed = scenario === "resume" ? await runHarness(harness, { state: result.state }, {
          resolveApprovals: async pending => pending.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }))
        }) : result;
        expect(completed.status).toBe("completed");
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after\n");
        expect(commands).toBe(scenario === "failed-recovered" ? 2 : 1); expect(calls).toBe(scenario === "failed-recovered" ? 3 : 2);
        const saved = await store.load("controller", harness.config.scope);
        expect(saved?.metadata?.[MODEL_BUDGET_KEY]).toMatchObject({ inputTokens: calls * 10, modelCalls: calls, usageComplete: true });
        expect(saved?.metadata?.[REPAIR_CONTROLLER_KEY]).toMatchObject({ phase: "delivered", revision: 1 });
        expect(saved?.metadata?.[RUNTIME_DIAGNOSTICS_KEY]).toMatchObject({ phase: "delivered" });
        const inspection = await inspectHarnessRun(store, harness.config, "controller");
        expect(inspection.runtimeDiagnostics?.phase).toBe("delivered");
        expect(inspection.runtimeDiagnostics?.modelTimings).toHaveLength(calls);
        expect(inspection.effectiveRuntime?.closureController).toBe(true);
        expect(inspection.runtimeDiagnostics?.checks.at(-1)).toMatchObject({ verified: true, exitCode: 0 });
      }
    } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("MCP matches response among fragmented multiline SSE and notifications", async () => {
  const server = normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{ name: "fixture", transport: "http", url: "https://fixture.invalid", permissions: ["network"], includeTools: ["lookup"] }] }).servers[0]!;
  const sse = 'data: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"tools":[]}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';
  const responses = [new Response(JSON.stringify({ id: 1, result: { protocolVersion: "2025-06-18" } })), new Response(null, { status: 202 }),
    new Response(new ReadableStream({ start(controller) { for (const char of sse) controller.enqueue(new TextEncoder().encode(char)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } })];
  const client = createHttpMcpClient(server, {}, (async () => responses.shift()!) as unknown as typeof fetch);
  expect(await client.listTools()).toEqual({ tools: [] });
});

import { tool } from "@zhivex-ai/core";
import { z } from "zod";
import { createRepairController } from "../src/repair-controller.js";
import { createRepairProgress } from "../src/repair-progress.js";
import { inspectRuntimeDiagnostics, inspectRuntimeManifest } from "../src/runtime-diagnostics.js";
import { missingPackageLinks } from "../scripts/package-documentation.js";

const execute = (tools: ToolSet, name: string, input: unknown) => {
  const selected = tools[name];
  if (!selected || !("execute" in selected)) throw new Error("Missing fixture tool");
  return selected.execute(input, { step: 1, metadata: {}, toolCall: { id: "fixture", name, input: {} }, model: createMockLanguageModel() });
};

test("batch reads enforce each normalized planned path before any filesystem read", async () => {
  let reads = 0;
  const progress = createRepairProgress(() => ({ inputTokens: 700, outputTokens: 0 }), { inputTokens: 1000, outputTokens: 1000 });
  const tools = progress.wrapTools({
    repair_plan: tool({ name: "repair_plan", schema: z.object({ paths: z.array(z.string()) }), execute: async () => "ok" }),
    read_files: tool({ name: "read_files", schema: z.object({ files: z.array(z.object({ path: z.string() })) }), execute: async () => { reads++; return "file"; } })
  });
  await execute(tools, "repair_plan", { paths: ["src/./parser.ts"] });
  await execute(tools, "read_files", { files: [{ path: "src/parser.ts" }] });
  await expect(execute(tools, "read_files", { files: [{ path: "src/parser.ts" }, { path: "src/../other.ts" }] })).rejects.toThrow("REPAIR_PLAN_SCOPE");
  expect(reads).toBe(1);
});

test("a failed mutation remains an explicit verification obligation", async () => {
  const controller = createRepairController({}, false);
  let effects = 0;
  const tools = controller.wrapTools({ apply_reviewed_edits: tool({ name: "apply_reviewed_edits", schema: z.object({}),
    execute: async (): Promise<string> => { effects++; throw new Error("after a partial write"); } }) });
  await expect(execute(tools, "apply_reviewed_edits", {})).rejects.toThrow("after a partial write");
  expect(effects).toBe(1);
  expect(controller.pending()).toBe(true);
  expect(controller.snapshot()).toMatchObject({ phase: "recover", verificationFailures: 1 });
  const resumed = createRepairController({ [REPAIR_CONTROLLER_KEY]: controller.snapshot() }, false);
  expect(resumed.pending()).toBe(true);
  resumed.markIncomplete();
  await expect(resumed.middleware.wrapGenerate!({ model: createMockLanguageModel(), input: { messages: [] } }, async () => ({}))).rejects.toThrow("REPAIR_INCOMPLETE");
});

test("unknown stream usage and cancellation cannot silently reopen the budget", async () => {
  const budget = createModelBudget({ inputTokens: 1000, outputTokens: 1000 });
  const context = { input: { messages: [] }, model: createMockLanguageModel() };
  const stream = await budget.middleware.wrapStream!(context, async () => (async function* () { yield { type: "text-delta" as const, textDelta: "partial" }; })());
  for await (const event of stream) expect(event.type).toBe("text-delta");
  expect(budget.snapshot().usageComplete).toBe(false);
  const restored = createModelBudget({ inputTokens: 1000, outputTokens: 1000 }, { saved: budget.snapshot() });
  await expect(restored.middleware.wrapGenerate!(context, async () => ({}))).rejects.toThrow("USAGE_UNAVAILABLE");
});

test("durable diagnostics strip unknown metadata and redact receipt text", () => {
  const budget = createModelBudget({ inputTokens: 1000, outputTokens: 1000 });
  const raw = { schemaVersion: 1, profile: "repair", budget: budget.stats, phase: "candidate", candidate: null,
    revision: 1, checks: [{ commandId: "check", purpose: "Contact owner@example.com", argvDigest: null, candidate: null, exitCode: 1, verified: false,
      stdout: "PRIVATE SOURCE" }], contextMeasurements: [], modelTimings: [], omittedContextMeasurements: 0, prompt: "PRIVATE SOURCE" };
  const projected = inspectRuntimeDiagnostics(raw);
  expect(projected?.checks[0]?.exitCode).toBe(1);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE SOURCE");
  expect(JSON.stringify(projected)).not.toContain("owner@example.com");
  expect(inspectRuntimeDiagnostics({ ...raw, modelTimings: [{ durationMs: -1 }] })).toBeNull();
  expect(inspectRuntimeManifest({ tools: ["PRIVATE SOURCE"] })).toBeNull();
});

test("published documentation resolves only archive-local files and directories", () => {
  const entries = new Set(["package/README.md", "package/docs/guide.md", "package/benchmarks/baselines/report.json"]);
  expect(missingPackageLinks("package/README.md", "[guide](./docs/guide.md#part) [baselines](./benchmarks/baselines/)", entries)).toEqual([]);
  expect(missingPackageLinks("package/README.md", "[missing](./src/private.ts) [escape](../../outside.md)", entries)).toEqual(["./src/private.ts", "../../outside.md"]);
  expect(missingPackageLinks("package/README.md", "```md\n[example](absent.md)\n```\n[site](https://example.com)", entries)).toEqual([]);
});

for (const payload of [
  'data: {"id":2,"result":{"tools":[]}}\n\ndata: {"id":2,"result":{"tools":[]}}\n\n',
  'data: {"id":99,"result":{"tools":[]}}\n\n',
  'data: not-json\n\n'
]) test("MCP rejects ambiguous, unmatched or malformed SSE responses", async () => {
  const server = normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{ name: "fixture", transport: "http", url: "https://fixture.invalid", permissions: ["network"], includeTools: ["lookup"] }] }).servers[0]!;
  const responses = [new Response(JSON.stringify({ id: 1, result: { protocolVersion: "2025-06-18" } })), new Response(null, { status: 202 }),
    new Response(payload, { headers: { "content-type": "text/event-stream" } })];
  const client = createHttpMcpClient(server, {}, (async () => responses.shift()!) as unknown as typeof fetch);
  await expect(client.listTools()).rejects.toThrow();
});

for (const apiMode of ["responses", "auto", "chat"] as const) test(`Qwen ${apiMode} keeps its supported request contract`, async () => {
  const model = { ...createMockLanguageModel(), provider: "qwen" };
  const budget = createModelBudget({ inputTokens: 1000, outputTokens: 1000 });
  const input: import("@zhivex-ai/core").ModelGenerateInput = { messages: [], providerOptions: { apiMode } };
  await budget.middleware.wrapGenerate!({ model, input }, async () => {
    expect(input.maxTokens !== undefined).toBe(apiMode === "chat");
    expect(input.providerOptions?.apiMode).toBe(apiMode);
    return { usage: { inputTokens: 10, outputTokens: 1 } };
  });
  expect(budget.stats.outputCapApplied).toBe(apiMode === "chat");
  const controller = createRepairController({}, true);
  controller.state.candidate = `sha256:${"a".repeat(64)}`;
  controller.state.phase = "candidate";
  const tools = { repair_plan: tool({ name: "repair_plan", schema: z.object({}), execute: async () => "ok" }) };
  const request: import("@zhivex-ai/core").ModelGenerateInput = { messages: [], tools, providerOptions: { apiMode }, reasoning: { effort: "low" } };
  await controller.middleware.wrapGenerate!({ model, input: request }, async () => {
    expect(request.toolChoice).toBe("auto");
    expect(Object.keys(request.tools ?? {})).toEqual(["repair_plan"]);
    return {};
  });
});

import { createQwen } from "@zhivex-ai/qwen";
import { wrapLanguageModel } from "@zhivex-ai/core";
for (const apiMode of ["responses", "chat"] as const) test(`published Qwen adapter accepts repaired ${apiMode} requests`, async () => {
  let requests = 0;
  const model = createQwen({ apiKey: "fixture", fetch: (async (url, init) => {
    requests++;
    expect(String(url)).toContain(apiMode === "chat" ? "/chat/completions" : "/responses");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.max_completion_tokens !== undefined).toBe(apiMode === "chat");
    expect(body.tool_choice).toBe("auto");
    return Response.json(apiMode === "chat" ? { id: "fixture", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } :
      { id: "fixture", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
  }) as typeof fetch })("qwen3.8-max");
  const controller = createRepairController({}, true);
  controller.state.candidate = `sha256:${"a".repeat(64)}`; controller.state.phase = "candidate";
  const budget = createModelBudget({ inputTokens: 5000, outputTokens: 1000 }, { closure: controller.closure });
  const wrapped = wrapLanguageModel(model, [controller.middleware, budget.middleware]);
  await wrapped.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Choose a verifier" }] }],
    tools: { repair_plan: tool({ name: "repair_plan", schema: z.object({}), execute: async () => "ok" }) },
    providerOptions: { apiMode }, reasoning: { effort: "low" } });
  expect(requests).toBe(1);
  expect(budget.stats.inputTokens).toBe(2);
});

test("combined edit transaction recovers into a freshly approved candidate verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhx-combined-recovery-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let commands = 0;
  const runtime: HarnessOciRuntimeAdapter = {
    async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference, imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
    async run(request) { commands++; return { command: request.command, exitCode: commands === 1 ? 4 : 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false }; },
    async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
  };
  const finish = { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 10, outputTokens: 2 } };
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "combined", name: "verify_and_apply_reviewed_edits", input: { changes: [{ path: "value.txt", expectedDigest: null, content: "after\n" }], command: "node", args: ["verify.mjs"] } } }, finish],
    [{ type: "tool-call", toolCall: { id: "corrected", name: "repair_plan", input: { hypothesis: "Correct fixture verifier", expectedBehavior: "required content", paths: ["value.txt"], nextCheck: "verify again", verifier: { command: "node", args: ["verify-corrected.mjs"], purpose: "assert required content" } } } }, finish]
  ] });
  const approvalIds: string[] = [];
  try {
    harness = await createHarness({ workspace: root, executionBackend: "oci", agentProfile: "repair", modelInstance: model,
      store: createInMemoryAgentRunStore(), ociRuntimeAdapter: runtime, ociAllowedCommands: ["node", "bun"], maxSteps: 6 });
    const result = await runHarness(harness, { prompt: "Create value.txt and verify the content." }, { resolveApprovals: async approvals => approvals.map(a => {
      approvalIds.push(a.id); return { provider: a.provider, approvalRequestId: a.id, approve: true };
    }) });
    expect(result.status).toBe("completed");
    expect(commands).toBe(2); expect(new Set(approvalIds).size).toBe(2);
    expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after\n");
    expect(result.toolResults.find(r => r.isError)?.output).toMatchObject({ kind: "terminal-verification-failure", verification: { exitCode: 4 } });
    expect(result.state.metadata?.[REPAIR_CONTROLLER_KEY]).toMatchObject({ phase: "delivered", verificationFailures: 1 });
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});
