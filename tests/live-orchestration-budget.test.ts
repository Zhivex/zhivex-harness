import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import type { HarnessDelegationContract } from "../src/runtime/delegation-contracts.js";

const contract: HarnessDelegationContract = {
  taskId: "release-review", profile: "reviewer", prompt: "Review both lines",
  allowedReadPaths: ["target.txt"], requiredOutput: "LEGACY",
  resultContract: { schemaVersion: 1, requiredReadPaths: ["target.txt"], humanReviewRequired: true, maxCorrections: 1 }
};

test("a repeated reviewer task in one response does not start a second child or exhaust the orchestration step limit", async () => {
  const root = await mkdtemp("/tmp/har-orchestration-budget-");
  await writeFile(root + "/target.txt", "one\ntwo");
  const result = {
    schemaVersion: 1, taskId: "release-review", status: "completed",
    inspectedFiles: [{ path: "target.txt", digest: "sha256:" + createHash("sha256").update("one\ntwo").digest("hex"),
      evidence: [{ toolCallId: "read", startLine: 1, endLine: 2 }] }],
    findings: [{ id: "finding", message: "Needs human review", evidence: [{ path: "target.txt", toolCallId: "read", startLine: 1, endLine: 2 }] }]
  };
  const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
  const read = { message: { role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: { id: "read", name: "read_file", input: { path: "target.txt" } } }] }, finishReason: "tool-calls" as const, usage };
  const text = (value: string) => ({ message: { role: "assistant" as const, parts: [{ type: "text" as const, text: value }] }, text: value, finishReason: "stop" as const, usage });
  let childCalls = 0;
  const childMock = createMockLanguageModel({ responses: [
    read, text("invalid"), text(JSON.stringify(result)),
    read, text(JSON.stringify(result))
  ] });
  const child = { ...childMock, generate: async (input: Parameters<typeof childMock.generate>[0]) => {
    childCalls += 1;
    return childMock.generate(input);
  } };
  const parentRequests: string[] = [];
  const parentMock = createMockLanguageModel({ streamEvents: [
    [
      { type: "tool-call", toolCall: { id: "delegate-a", name: "delegate_reviewer", input: { taskId: "release-review" } } },
      { type: "tool-call", toolCall: { id: "delegate-b", name: "delegate_reviewer", input: { taskId: "release-review" } } },
      { type: "finish", finishReason: "tool-calls", usage }
    ],
    [{ type: "text-delta", textDelta: "Parent summary" }, { type: "finish", finishReason: "stop", usage }]
  ] });
  const parent = { ...parentMock, stream: async (input: Parameters<NonNullable<typeof parentMock.stream>>[0]) => {
    parentRequests.push(JSON.stringify(input.messages));
    return parentMock.stream!(input);
  } };
  const harness = await createHarness({
    workspace: root, subagentProfiles: ["reviewer"], subagentModels: { reviewer: child }, modelInstance: parent,
    maxSteps: 6, maxToolCalls: 4, subagentMaxSteps: 4, subagentMaxToolCalls: 2,
    delegationContracts: [contract]
  });
  try {
    const output = await runHarness(harness, { runId: "parent", prompt: "Review", maxSteps: 6 });
    expect(output.status).toBe("completed");
    expect(childCalls).toBe(3);
    expect(output.state.childRuns).toHaveLength(1);
    expect(output.state.childRuns?.[0]?.status).toBe("completed");
    const delegations = output.toolResults.filter(entry => entry.toolName === "delegate_reviewer");
    expect(delegations.filter(entry => !entry.isError)).toHaveLength(1);
    expect(delegations.find(entry => entry.isError)?.error?.code).toBe("TOOL_INPUT_VALIDATION_ERROR");
    expect(parentRequests[1]).toContain("Do not call delegate_reviewer again");
    expect(parentRequests[1]).toContain("release-review");
    expect(parentRequests[1]).not.toContain("Retry delegate_reviewer");
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
