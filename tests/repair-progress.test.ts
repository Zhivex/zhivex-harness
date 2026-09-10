import { expect, test } from "bun:test";
import { tool, type ToolSet } from "@zhivex-ai/core";
import { z } from "zod";
import { createRepairProgress } from "../src/repair-progress.js";
import { measureContext } from "../scripts/swebench/context-metrics.js";

const limits = { inputTokens: 1000, outputTokens: 100 };
const call = (tools: ToolSet, name: string, input: unknown = {}) => (tools[name] as any).execute(input, {});

test("suppresses only a third unchanged result and rereads after content changes", async () => {
  let content = "private source";
  let reads = 0;
  const controller = createRepairProgress(() => ({ inputTokens: 0, outputTokens: 0 }), limits);
  const schema = z.object({ path: z.string() });
  const tools = controller.wrapTools({ read_file: tool({ name: "read_file", schema,
    execute: async () => { reads++; return { content }; } }) });
  for (let i = 0; i < 2; i++) expect(await call(tools, "read_file", { path: "a.ts" })).toEqual({ content });
  await expect(call(tools, "read_file", { path: "a.ts" })).rejects.toThrow("REPEATED_EXPLORATION");
  expect(reads).toBe(3);
  content = "changed source";
  expect(await call(tools, "read_file", { path: "a.ts" })).toEqual({ content });
  expect("schema" in tools.read_file! && tools.read_file.schema).toBe(schema);
  expect(JSON.stringify(controller.stats)).not.toContain("source");
});

test("closure reserves the last 30 percent from global discovery while permitting focused repair", async () => {
  const usage = { inputTokens: 699, outputTokens: 0 };
  const controller = createRepairProgress(() => usage, limits);
  let reads = 0;
  const tools = controller.wrapTools(Object.fromEntries(["list_files", "search_many", "read_files", "verify_and_apply_environment_patch"].map(name => [name,
    tool({ name, schema: z.object({ path: z.string().optional() }), requiresApproval: name.startsWith("verify"),
      approvalMode: "interrupt", approvalVersion: "fixture", execute: async () => { reads++; return "ok"; } })])));
  expect(await call(tools, "search_many", { path: "." })).toBe("ok");
  usage.inputTokens = 700;
  await expect(call(tools, "search_many", { path: "." })).rejects.toThrow("REPAIR_CLOSURE");
  await expect(call(tools, "list_files")).rejects.toThrow("REPAIR_CLOSURE");
  expect(reads).toBe(1);
  expect(await call(tools, "search_many", { path: "src/parser.ts" })).toBe("ok");
  expect(await call(tools, "read_files")).toBe("ok");
  expect(tools.verify_and_apply_environment_patch).toMatchObject({ requiresApproval: true, approvalMode: "interrupt", approvalVersion: "fixture" });
  expect(await call(tools, "verify_and_apply_environment_patch")).toBe("ok");
  expect(controller.stats.blockedBroadCalls).toBe(2);
});

test("failed commands invalidate repetition history and are never deduplicated", async () => {
  const controller = createRepairProgress(() => ({ inputTokens: 0, outputTokens: 0 }), limits);
  let effects = 0;
  const tools = controller.wrapTools({
    read_file: tool({ name: "read_file", schema: z.object({}), execute: async () => "same" }),
    run_environment_command: tool({ name: "run_environment_command", schema: z.object({}), execute: async (): Promise<string> => { effects++; throw new Error("failed after effect"); } })
  });
  await call(tools, "read_file"); await call(tools, "read_file");
  for (let i = 0; i < 3; i++) await expect(call(tools, "run_environment_command")).rejects.toThrow("failed after effect");
  expect(effects).toBe(3);
  expect(await call(tools, "read_file")).toBe("same");
  const fresh = createRepairProgress(() => ({ inputTokens: 0, outputTokens: 70 }), limits);
  expect(fresh.closing()).toBe(true);
  expect(fresh.stats.repeatedResults).toBe(0);
});

test("context measurements separate components without mutating or retaining content", () => {
  const input: any = { messages: [
    { role: "system", parts: [{ type: "text", text: "PRIVATE SYSTEM" }] },
    { role: "user", parts: [{ type: "text", text: "PRIVATE USER" }] },
    { role: "assistant", parts: [{ type: "text", text: "PRIVATE HISTORY" }] },
    { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "x", toolName: "read", output: "PRIVATE RESULT" } }] }
  ], tools: { read: tool({ name: "read", description: "PRIVATE DESCRIPTION", schema: z.object({ path: z.string() }), execute: async () => "" }) } };
  const original = JSON.stringify(input);
  const counts = measureContext(input);
  expect(counts.systemCharacters).toBe(JSON.stringify(input.messages[0]).length);
  expect(counts.userCharacters).toBeGreaterThan(0);
  expect(counts.assistantCharacters).toBeGreaterThan(0);
  expect(counts.toolResultCharacters).toBeGreaterThan(0);
  expect(counts.toolDefinitionCharacters).toBeGreaterThan(0);
  expect(counts.unmeasuredToolDefinitions).toBe(0);
  expect(JSON.stringify(counts)).not.toContain("PRIVATE");
  expect(JSON.stringify(input)).toBe(original);
});

test("agent can recover from suppressed exploration through the existing tool-error loop", async () => {
  const { createMockLanguageModel, streamText } = await import("@zhivex-ai/core");
  const controller = createRepairProgress(() => ({ inputTokens: 0, outputTokens: 0 }), limits);
  let executions = 0;
  const tools = controller.wrapTools({ read_file: tool({ name: "read_file", schema: z.object({ startLine: z.number() }),
    execute: async ({ startLine }) => { executions++; return { content: `line ${startLine}` }; } }) });
  const model = createMockLanguageModel({ streamEvents: [1, 1, 1, 2].map((startLine, i) => [
    { type: "tool-call" as const, toolCall: { id: `call-${i}`, name: "read_file", input: { startLine } } },
    { type: "finish" as const, finishReason: "tool-calls" as const }
  ]).concat([[{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }] as any]) });
  const result = await streamText({ model, tools, prompt: "Read the next slice when told to change scope.",
    maxSteps: 5, toolExecution: { stopOnError: false } }).collect();
  expect(result.text).toBe("done");
  expect(executions).toBe(4);
  expect(controller.stats.suppressedResults).toBe(1);
});

test("context measurements stay bounded without dropping actual token accounting", async () => {
  const { createModelBudget } = await import("../scripts/swebench/model-budget.js");
  const budget = createModelBudget({ inputTokens: 10000, outputTokens: 10000 });
  for (let i = 0; i < 130; i++) await budget.middleware.wrapGenerate!({ input: { messages: [] }, model: {} } as never,
    async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }) as never);
  expect(budget.contextMetrics).toHaveLength(128);
  expect(budget.omittedContextMeasurements).toBe(2);
  expect(budget.stats.inputTokens).toBe(130);
  expect(budget.stats.modelCalls).toBe(130);
});
