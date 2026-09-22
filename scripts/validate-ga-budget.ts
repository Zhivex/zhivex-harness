/** External GA acceptance probe: two model turns must fit in the default budget.
 * Run with `bun run scripts/validate-ga-budget.ts`. No credentials or network.
 * Exit 1 means the candidate fails acceptance; do not relax the budget to pass.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

for (const provider of ["meta", "openai", "qwen"] as const) {
  const workspace = await mkdtemp(path.join(tmpdir(), "ga-budget-repro-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const model = createMockLanguageModel({ streamEvents: [
      [
        { type: "tool-call", toolCall: { id: "read", name: "list_files", input: {} } },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      ],
      [
        { type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      ]
    ] });
    harness = await createHarness({ workspace, provider, modelInstance: model,
      store: createInMemoryAgentRunStore(), subagentProfiles: [], maxSteps: 4 });
    const result = await runHarness(harness, { prompt: "List files, then finish." });
    const passed = result.status === "completed" && result.outputText === "done" &&
      result.usage?.outputTokens === 4 && result.toolResults.length === 1 &&
      result.toolResults[0]?.isError === false;
    console.log(JSON.stringify({ provider, passed, status: result.status, outputTokens: result.usage?.outputTokens }));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    const outer = record(error);
    const cause = record(outer.cause);
    const metadata = record(cause.metadata);
    console.log(JSON.stringify({ provider, passed: false, status: "failed", code: outer.code,
      cause: cause.name, stage: cause.stage, budgetLimit: metadata.budgetLimit,
      limit: metadata.limit, actual: metadata.actual, required: metadata.required,
      remaining: metadata.remaining }));
    process.exitCode = 1;
  } finally {
    await harness?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
