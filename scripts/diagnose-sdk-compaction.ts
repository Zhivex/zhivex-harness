/** Offline upstream reproduction: no credentials, network, harness workarounds or workspace input. */
import { Agent, tool } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { z } from "zod";

const model = createMockLanguageModel({ streamEvents: [
  ...["one", "two"].map((id) => [
    { type: "tool-call" as const, toolCall: { id, name: "inspect", input: {} } },
    { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }
  ]),
  [{ type: "text-delta", textDelta: "done" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }]
] });
const agent = new Agent({
  model, maxSteps: 3, store: createInMemoryAgentRunStore(),
  tools: { inspect: tool({ name: "inspect", description: "Read a fixture", schema: z.object({}), execute: () => ({ fixture: "x".repeat(500) }) }) },
  compaction: { maxMessages: 4, keepRecentMessages: 2, compactor: async () => ({ summary: "Inspected fixture." }) }
});
const streamed = agent.stream({ prompt: "Inspect twice, then finish." });
for await (const _event of streamed.eventStream) { /* Drain the public stream. */ }
const output = await streamed.collect();
const measuredInputTokens = output.steps.reduce((sum, step) => sum + (step.response?.usage?.inputTokens ?? 0), 0);
console.log(JSON.stringify({ status: output.status, compactions: output.state.compactions?.length ?? 0,
  measuredInputTokens, reportedUsage: output.usage, matchesMeasuredInput: output.usage?.inputTokens === measuredInputTokens }, null, 2));
