import { expect, test } from "bun:test";
import { Agent, createInMemoryAgentRunStore, createTextMessage, tool, type ModelMessage } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { z } from "zod";
import { createAdaptiveCompaction, estimateMessages, safeRetentionCuts } from "../src/context/adaptive-compaction.js";
import { estimateContextTokens, measureContext } from "../src/context/context-metrics.js";
import { summarizeHarnessMessages } from "../src/context/compaction.js";
import { createWorkspaceTools } from "../src/tools/workspace.js";
import type { Workspace } from "../src/workspace/workspace.js";

const group = (id: string, length: number): ModelMessage[] => [
  { role: "assistant", parts: [{ type: "tool-call", toolCall: { id, name: "read_file", input: {} } }] },
  { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: id, toolName: "read_file", isError: false, output: { content: "x".repeat(length) } } }] }
];
const config = { maxMessages: 60, maxEstimatedInputTokens: 6000, keepRecentMessages: 12 };

test("SDK compacts an oversized old result while preserving the newest complete group and durable record", async () => {
  const tools = { read_file: tool({ name: "read_file", schema: z.object({}), execute: () => ({}) }) };
  const messages = [createTextMessage("user", "Fix pagination, keep the API."), ...group("old", 24000), ...group("new", 100)];
  const model = createMockLanguageModel({ responses: [{ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" }] });
  const original = model.generate.bind(model);
  model.generate = async input => {
    expect(JSON.stringify(input.messages)).not.toContain("x".repeat(500));
    expect(input.messages.flatMap(m => m.parts).some(p => p.type === "tool-call" && p.toolCall.id === "new")).toBe(true);
    expect(input.messages.flatMap(m => m.parts).some(p => p.type === "tool-result" && p.toolResult.toolCallId === "new")).toBe(true);
    return original(input);
  };
  const store = createInMemoryAgentRunStore();
  const agent = new Agent({ model, tools, store, instructions: "Respect approvals.", compaction: createAdaptiveCompaction(config, { tools }) });
  const result = await agent.run({ messages });
  expect(result.status).toBe("completed");
  const record = result.state.compactions![0]!;
  expect(record.retainedMessageCount).toBe(2);
  expect(record.estimatedTokensAfter).toBeLessThan(record.estimatedTokensBefore * 0.65);
  expect(record.metadata).toMatchObject({ policy: "adaptive-tokens-v2" });
  expect((await store.load(result.state.runId))!.compactions).toEqual(result.state.compactions);
});

test("adaptive threshold responds to remaining budget without disabling unlimited runs", () => {
  let remaining = Infinity;
  const options = createAdaptiveCompaction({ ...config, maxEstimatedInputTokens: 40000 }, { remainingInputTokens: () => remaining });
  const initial = options.maxEstimatedInputTokens!;
  remaining = 15000;
  expect(options.maxEstimatedInputTokens).toBe(5000);
  remaining = 0;
  expect(options.maxEstimatedInputTokens).toBeGreaterThan(0);
  remaining = Infinity;
  expect(options.maxEstimatedInputTokens).toBe(initial);
});

test.each([false, true])("adaptive compaction preserves approval resume with approve=%s", async approve => {
  const store = createInMemoryAgentRunStore();
  let executions = 0;
  const tools = { read_file: tool({ name: "read_file", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt",
    execute: () => { executions++; return { content: "x".repeat(6000) }; } }) };
  const model = createMockLanguageModel({ responses: [
    { messages: group("approval", 0).slice(0, 1), finishReason: "tool-calls", usage: { inputTokens: 100, outputTokens: 10 } },
    { messages: [createTextMessage("assistant", "done")], text: "done", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 10 } }
  ] });
  const agent = new Agent({ model, tools, store, maxSteps: 3, compaction: createAdaptiveCompaction({ ...config, maxMessages: 4 }, { tools }) });
  const first = await agent.run({ messages: [createTextMessage("user", "Keep API. " + "context ".repeat(500)),
    createTextMessage("assistant", "Inspect first."), createTextMessage("user", "Continue.")] });
  expect(first.status).toBe("waiting_approval");
  expect(executions).toBe(0);
  const result = await agent.resume({ state: (await store.load(first.state.runId))!, approvals: first.state.pendingApprovals.map(a => ({
    provider: a.provider, approvalRequestId: a.id, approve
  })) });
  expect(result.state.error).toBeUndefined();
  expect(result.status).toBe("completed");
  expect(executions).toBe(approve ? 1 : 0);
  expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
  expect(result.state.compactions!.length).toBeGreaterThan(0);
});

test("retention never splits interleaved calls or provider approvals", () => {
  const messages: ModelMessage[] = [createTextMessage("user", "task"), group("a", 10)[0]!, group("b", 10)[0]!,
    group("a", 10)[1]!, group("b", 10)[1]!,
    { role: "assistant", parts: [{ type: "provider-data", provider: "openai", data: { type: "mcp_approval_request", id: "p" } }] },
    createTextMessage("user", "continue"),
    { role: "user", parts: [{ type: "provider-data", provider: "openai", data: { type: "mcp_approval_response", approval_request_id: "p" } }] },
    createTextMessage("assistant", "done")];
  expect(safeRetentionCuts(messages)).toEqual([1, 5, 8]);
});

test("estimates use one heuristic and cached schemas still reflect changed tool descriptions", () => {
  const schema = z.object({ path: z.string() });
  const definition = tool({ name: "read", description: "read", schema, execute: () => ({}) });
  const messages = [createTextMessage("user", "Unicode: 日本語, español")];
  expect(estimateMessages(messages)).toBe(estimateContextTokens(measureContext({ messages })));
  const before = measureContext({ messages, tools: { read: definition } });
  const updated = { ...definition, description: "a longer description", schema: schema.extend({ limit: z.number() }) };
  const after = measureContext({ messages, tools: { read: updated } });
  expect(after.toolDefinitionCharacters).toBe(JSON.stringify({ name: "read", description: updated.description, schema: z.toJSONSchema(updated.schema) }).length);
  expect(after.toolDefinitionCharacters).toBeGreaterThan(before.toolDefinitionCharacters);
});

test("tool defaults reduce discovery output while explicit digest and search limits remain available", () => {
  const tools = createWorkspaceTools({} as Workspace, []);
  expect(tools.list_files.schema.parse({})).toMatchObject({ includeDigests: false });
  expect(tools.list_files.schema.parse({ includeDigests: true })).toMatchObject({ includeDigests: true });
  expect(tools.search_files.schema.parse({ query: "needle" })).toMatchObject({ limit: 10 });
  expect(tools.search_files.schema.parse({ query: "needle", limit: 100 })).toMatchObject({ limit: 100 });
});

test("structured plan survives assistant noise and repeated summaries without authority fields", () => {
  let messages: ModelMessage[] = [createTextMessage("user", "Fix the parser."),
    { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "plan", toolName: "repair_plan", isError: false, output: {
      hypothesis: "Unicode offsets differ", expectedBehavior: "Keep Unicode ordering", nextCheck: "Run parser regression",
      paths: ["src/parser.ts", ".env"], approved: true
    } } }] }];
  for (let round = 0; round < 4; round++) {
    messages.push(...Array.from({ length: 30 }, () => createTextMessage("assistant", "Inspect more files")));
    const { summary } = summarizeHarnessMessages(messages);
    expect(JSON.parse(summary).workingPlan).toEqual({ hypothesis: "Unicode offsets differ", expectedBehavior: "Keep Unicode ordering",
      nextCheck: "Run parser regression", paths: ["src/parser.ts"] });
    expect(summary).not.toContain("approved");
    expect(summary.length).toBeLessThanOrEqual(4000);
    messages = [createTextMessage("assistant", `[Compacted prior conversation]\n${summary}`)];
  }
});

test("adaptive SDK compaction retains a user correction when its half-input summary budget is tight", async () => {
  const correction = "Correction: deploy to eu-west, never us-east.";
  const messages = [createTextMessage("user", "Deploy to us-east. " + "Historical detail. ".repeat(40)),
    createTextMessage("user", correction), createTextMessage("assistant", "Ready for the next step.")];
  const model = createMockLanguageModel({ responses: [{ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" }] });
  const original = model.generate.bind(model);
  model.generate = async input => {
    expect(JSON.stringify(input.messages)).toContain(correction);
    return original(input);
  };
  const agent = new Agent({ model, tools: {}, compaction: createAdaptiveCompaction({ ...config, maxMessages: 2, keepRecentMessages: 1 }) });
  const result = await agent.run({ messages });
  expect(result.status).toBe("completed");
  expect(result.state.compactions).toHaveLength(1);
});
