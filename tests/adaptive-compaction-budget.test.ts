import { expect, test } from "bun:test";
import { Agent, createInMemoryAgentRunStore, createTextMessage, tool, type ModelMessage } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { z } from "zod";
import { createAdaptiveCompaction } from "../src/context/adaptive-compaction.js";

const toolGroup = (id: string, length: number): ModelMessage[] => [
  { role: "assistant", parts: [{ type: "tool-call", toolCall: { id, name: "read_files", input: { paths: ["src/value.ts"] } } }] },
  { role: "tool", parts: [{ type: "tool-result", toolResult: {
    toolCallId: id, toolName: "read_files", isError: false, output: { content: "x".repeat(length) }
  } }] }
];

test.each([false, true])("fits summary within the unchanged token cap with escapedObjective=%s", async (escapedObjective) => {
  const tools = { read_files: tool({ name: "read_files", description: "Bounded repository reading. ".repeat(250),
    schema: z.object({ paths: z.array(z.string()).describe("Only approved repository-relative paths. ".repeat(100)) }),
    execute: () => ({}) }) };
  const objective = escapedObjective ? 'Repair "value" at \\src\\value.ts without changing tests. ' : "Repair the value without changing tests. ";
  const messages = [createTextMessage("user", objective.repeat(60)),
    ...toolGroup("old", 24_000), ...toolGroup("latest", 3_000)];
  let modelCalls = 0;
  const model = createMockLanguageModel({ responses: [{ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" }] });
  const generate = model.generate.bind(model);
  model.generate = async input => { modelCalls++; return generate(input); };
  const compaction = createAdaptiveCompaction({ maxMessages: 16, maxEstimatedInputTokens: 12_000, keepRecentMessages: 2 }, { tools });
  const agent = new Agent({ model, tools, store: createInMemoryAgentRunStore(),
    instructions: "Bounded policy. ".repeat(2_000), compaction });

  const originalThreshold = compaction.maxEstimatedInputTokens!;
  const result = await agent.run({ messages });
  expect(result.status).toBe("completed");
  expect(modelCalls).toBe(1);
  expect(compaction.maxEstimatedInputTokens).toBe(originalThreshold);
  expect(result.state.compactions?.[0]?.estimatedTokensAfter).toBeLessThanOrEqual(originalThreshold);
  expect(result.state.compactions?.[0]?.retainedMessageCount).toBe(2);
  const parts = result.messages.flatMap(message => message.parts);
  expect(parts.some(part => part.type === "tool-call" && part.toolCall.id === "latest")).toBe(true);
  expect(parts.some(part => part.type === "tool-result" && part.toolResult.toolCallId === "latest")).toBe(true);

  // An independently short summary confirms that the protected policy and
  // newest complete tool group fit without raising the configured threshold.
  const fittingCompaction = createAdaptiveCompaction({ maxMessages: 16, maxEstimatedInputTokens: 12_000, keepRecentMessages: 2 }, { tools });
  fittingCompaction.compactor = () => ({ summary: "Repair src/value.ts without changing tests." });
  const fittingModel = createMockLanguageModel({ responses: [{ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" }] });
  const fittingAgent = new Agent({ model: fittingModel, tools, store: createInMemoryAgentRunStore(),
    instructions: "Bounded policy. ".repeat(2_000), compaction: fittingCompaction });
  const fitted = await fittingAgent.run({ messages });
  expect(fitted.status).toBe("completed");
  expect(fitted.state.compactions?.[0]?.estimatedTokensAfter).toBeLessThanOrEqual(fittingCompaction.maxEstimatedInputTokens!);
  expect(fitted.state.compactions?.[0]?.retainedMessageCount).toBe(2);
});

test("rejects when the protected policy and newest tool group cannot fit", async () => {
  let modelCalls = 0;
  const model = createMockLanguageModel({ responses: [] });
  const generate = model.generate.bind(model);
  model.generate = async input => { modelCalls++; return generate(input); };
  const tools = { read_files: tool({ name: "read_files", schema: z.object({ paths: z.array(z.string()) }), execute: () => ({}) }) };
  const compaction = createAdaptiveCompaction({ maxMessages: 16, maxEstimatedInputTokens: 12_000, keepRecentMessages: 2 }, { tools });
  const threshold = compaction.maxEstimatedInputTokens!;
  const agent = new Agent({ model, tools, instructions: "Bounded policy. ".repeat(2_200), compaction });
  await expect(agent.run({ messages: [createTextMessage("user", "Repair the value."),
    ...toolGroup("old", 24_000), ...toolGroup("latest", 6_000)] })).rejects.toThrow();
  expect(modelCalls).toBe(0);
  expect(compaction.maxEstimatedInputTokens).toBe(threshold);
});
