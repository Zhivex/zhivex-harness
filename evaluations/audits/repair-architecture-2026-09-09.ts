/** Read-only runtime audit using temporary fixtures; no provider or Docker calls. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "@zhivex-ai/core";
import { createWorkspaceTools, estimateMessageTokens } from "../../src/harness.js";
import { Workspace } from "../../src/workspace.js";
import { createRepairProgress } from "../../src/repair-progress.js";
import { createTaskTools } from "../../src/task-memory.js";
import { createModelBudget } from "../../src/model-budget.js";
import { summarizeHarnessMessages } from "../../src/compaction.js";

const root = await mkdtemp(join(tmpdir(), "zhx-architecture-audit-"));
try {
  await writeFile(join(root, "planned.txt"), "planned evidence\n");
  await writeFile(join(root, "unplanned.txt"), "other evidence\n");
  const workspace = await Workspace.open(root);
  const usage = { inputTokens: 70_000, outputTokens: 0 };
  const progress = createRepairProgress(() => usage, { inputTokens: 100_000, outputTokens: 16_000 });
  const tools = progress.wrapTools({ ...createWorkspaceTools(workspace, []), ...createTaskTools() });
  let step = 0;
  const invoke = async (catalog: ToolSet, name: string, input: unknown) => {
    const definition = catalog[name]!;
    if (!("execute" in definition)) throw new Error("Fixture requires local tool");
    const parsed = definition.schema.parse(input);
    return definition.execute(parsed, { step: step++, metadata: {} } as never);
  };
  await invoke(tools, "repair_plan", { paths: ["planned.txt"], hypothesis: "fixture", expectedBehavior: "fixture", nextCheck: "fixture" });
  let singleReadBlocked = false;
  try { await invoke(tools, "read_file", { path: "unplanned.txt" }); }
  catch (error) { singleReadBlocked = String(error).includes("REPAIR_PLAN_SCOPE"); }
  const batch = await invoke(tools, "read_files", { files: [{ path: "unplanned.txt" }] }) as { files: unknown[] };

  const budget = createModelBudget({ inputTokens: 100_000, outputTokens: 16_000 });
  budget.stats.inputTokens = 70_000;
  let acceptedRequests = 0;
  for (let i = 0; i < 3; i++) {
    await budget.middleware.wrapGenerate!({ input: { messages: [] }, model: {} } as never,
      async () => ({ usage: { inputTokens: 10_000, outputTokens: 10 } }) as never);
    acceptedRequests++;
  }
  let nextRequestBlocked = false;
  try { await budget.middleware.wrapGenerate!({ input: { messages: [] }, model: {} } as never, async () => ({}) as never); }
  catch { nextRequestBlocked = true; }

  const checkSummary = summarizeHarnessMessages([
    { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "check", name: "run_environment_command", input: { command: "python", args: ["-c", "assert 2 + 2 == 4"] } } }] },
    { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "check", toolName: "run_environment_command", isError: false, output: { exitCode: 0 } } }] }
  ]).summary;
  console.log(JSON.stringify({ networkCalls: 0, productionFilesChanged: false,
    scope: { singleReadBlocked, batchReadOutsidePlanReturnedFiles: batch.files.length, phaseWithoutReproductionOrEdit: progress.stats.phase },
    reservation: { acceptedRequests, inputTokens: budget.stats.inputTokens, nextRequestBlocked, verificationReserveTokens: 100_000 - budget.stats.inputTokens },
    compaction: { retainsExitCode: checkSummary.includes('"exitCode"') || checkSummary.includes('\\"exitCode\\"'), retainsCheckAssertion: checkSummary.includes("assert 2 + 2 == 4") },
    estimator: { messagesOnlyTokens: estimateMessageTokens([]), acceptsToolCatalogArgument: false }
  }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
