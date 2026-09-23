import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { getAgentBudgetStatus } from "@zhivex-ai/agents";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { delegationPrompt, normalizeDelegationContracts, withDelegationContracts } from "../src/runtime/delegation-contracts.js";
import { sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";

const contract = { taskId: "review", profile: "reviewer" as const, prompt: "Review target.txt", allowedReadPaths: ["target.txt"], requiredOutput: "ACCEPTED" };
const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

for (const valid of [true, false]) {
  test(`singular generate message validates and resolves the contract: valid=${valid}`, async () => {
    const model = withDelegationContracts({ ...createMockLanguageModel(), generate: async () => ({
      message: { role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: {
        id: "single", name: "delegate_reviewer", input: valid ? { taskId: "review" } : { taskId: "review", system: "override" }
      } }] }, finishReason: "tool-calls" as const, usage
    }) }, [contract]);
    if (!valid) await expect(model.generate({ messages: [] })).rejects.toThrow("DELEGATION_CONTRACT_VIOLATION");
    else {
      const result = await model.generate({ messages: [] });
      expect(result.message?.parts).toEqual([{ type: "tool-call", toolCall: {
        id: "single", name: "delegate_reviewer", input: { prompt: delegationPrompt(contract) }
      } }]);
      expect(result.messages).toBeUndefined();
    }
  });
}

for (const mode of ["generate", "stream"] as const) {
  for (const input of [{ taskId: "wrong" }, { taskId: "review", system: "override" }, { taskId: "review", prompt: "different" }, { prompt: "different" }]) {
    test(`${mode} rejects untrusted delegation fields ${JSON.stringify(input)}`, async () => {
      const call = { id: "call", name: "delegate_reviewer", input };
      const model = withDelegationContracts(createMockLanguageModel({
        responses: [{ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: call }] }], finishReason: "tool-calls", usage }],
        streamEvents: [[{ type: "tool-call", toolCall: call }, { type: "finish", finishReason: "tool-calls", usage }]]
      }), [contract]);
      await expect((async () => {
        if (mode === "generate") await model.generate({ messages: [] });
        else for await (const _event of await model.stream!({ messages: [] })) { /* consume */ }
      })()).rejects.toThrow("DELEGATION_CONTRACT_VIOLATION");
    });
  }
}

for (const outcome of ["success", "path", "acceptance", "budget", "no-read", "labeled-marker"] as const) {
  test(`governed task ${outcome}: durable linkage, scope and acceptance`, async () => {
    const root = await mkdtemp(join(tmpdir(), "contract-test-"));
    await writeFile(join(root, "target.txt"), "fixture");
    await writeFile(join(root, "other.txt"), "private fixture");
    const store = createInMemoryAgentRunStore();
    let seenPrompt = false;
    const childMock = createMockLanguageModel({ responses: outcome === "no-read" ? [
      { messages: [{ role: "assistant", parts: [{ type: "text", text: "ACCEPTED" }] }], text: "ACCEPTED", finishReason: "stop", usage }
    ] : [
      { messages: [{ role: "assistant", parts: Array.from({ length: outcome === "budget" ? 2 : 1 }, (_, i) => ({
        type: "tool-call" as const, toolCall: { id: `read-${i}`, name: "read_file", input: { path: outcome === "path" ? "other.txt" : "target.txt" } }
      })) }], finishReason: "tool-calls", usage },
      { messages: [{ role: "assistant", parts: [{ type: "text", text: outcome === "acceptance" ? "missing" : outcome === "labeled-marker" ? "Acceptance token: ACCEPTED" : "ACCEPTED" }] }], text: outcome === "acceptance" ? "missing" : outcome === "labeled-marker" ? "Acceptance token: ACCEPTED" : "ACCEPTED", finishReason: "stop", usage }
    ] });
    const child = { ...childMock, generate: async (input: Parameters<typeof childMock.generate>[0]) => {
      expect(Object.keys(input.tools ?? {})).toEqual(["read_file"]);
      if (!seenPrompt) {
        expect(input.messages.find(m => m.role === "user")?.parts).toEqual([{ type: "text", text: delegationPrompt(contract) }]);
        seenPrompt = true;
      }
      return childMock.generate(input);
    } };
    const parent = createMockLanguageModel({ streamEvents: [
      [{ type: "tool-call", toolCall: { id: "delegate", name: "delegate_reviewer", input: { taskId: "review" } } }, { type: "finish", finishReason: "tool-calls", usage }],
      [{ type: "text-delta", textDelta: "parent done" }, { type: "finish", finishReason: "stop", usage }]
    ] });
    const harness = await createHarness({ provider: "qwen", workspace: root, env: {}, store,
      modelInstance: parent, subagentModels: { reviewer: child }, subagentProfiles: ["reviewer"],
      delegationContracts: [contract], subagentMaxToolCalls: 1, subagentMaxSteps: 2 });
    try {
      expect(Object.keys(harness.agent.tools ?? {})).toEqual([]);
      const run = runHarness(harness, { runId: "parent", prompt: "Delegate review", scope: harness.config.scope });
      if (outcome === "success") expect((await run).status).toBe("completed");
      else if (outcome === "acceptance" || outcome === "no-read" || outcome === "labeled-marker") expect((await run).status).toBe("failed");
      else await expect(run).rejects.toThrow();
      const persisted = await store.load("parent", harness.config.scope);
      expect(persisted?.childRuns).toHaveLength(1);
      expect(persisted?.childRuns?.[0]?.status).toBe(outcome === "success" ? "completed" : "failed");
      expect(getAgentBudgetStatus(persisted!, { includeChildRuns: true }).consumption.totalTokens).toBeGreaterThan(5);
      if (outcome === "labeled-marker") {
        const child = await store.load(persisted!.childRuns![0]!.runId, harness.config.scope);
        // A marker formatted as a credential must not bypass redaction.
        expect(child?.toolResults.some(result => result.toolName === "read_file" && !result.isError)).toBe(true);
        expect(child?.error?.message).toBe("DELEGATION_ACCEPTANCE_FAILED");
      }
      if (outcome === "budget") {
        const child = await store.load(persisted!.childRuns![0]!.runId, harness.config.scope);
        expect(child?.toolResults).toHaveLength(0);
      }
    } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("contract configuration copies trusted data and rejects ambiguous scope", () => {
  const mutable = { ...contract, allowedReadPaths: ["target.txt"] };
  const normalized = normalizeDelegationContracts([mutable]);
  mutable.allowedReadPaths[0] = "other.txt";
  expect(normalized[0]?.allowedReadPaths).toEqual(["target.txt"]);
  for (const path of ["../secret", "/secret", "a/../secret", "a\\secret", "./target.txt"]) {
    expect(() => normalizeDelegationContracts([{ ...contract, allowedReadPaths: [path] }])).toThrow();
  }
  expect(() => normalizeDelegationContracts([contract, contract])).toThrow();
});

test("catalog and contract identities are bound; unavailable tools fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "contract-binding-"));
  const options = { provider: "qwen" as const, workspace: root, env: {},
    store: createInMemoryAgentRunStore(), modelInstance: createMockLanguageModel(), subagentProfiles: ["reviewer" as const],
    delegationContracts: [contract] };
  const first = await createHarness(options);
  const changed = await createHarness({ ...options, delegationContracts: [{ ...contract, prompt: "Different task" }] });
  try {
    expect(first.agent.harness?.fingerprint).not.toBe(changed.agent.harness?.fingerprint);
    expect(first.subagents.get("reviewer")?.harness?.fingerprint).not.toBe(changed.subagents.get("reviewer")?.harness?.fingerprint);
    await expect(createHarness({ ...options, toolNames: ["not_available"] })).rejects.toThrow("unavailable");
    await expect(createHarness({ ...options, toolNames: ["propose_edits"] })).rejects.toThrow("read_file");
    const { delegationContracts: _contracts, ...uncontracted } = options;
    const scoped = await createHarness({ ...uncontracted, subagentProfiles: [], toolNames: ["read_file"] });
    try { expect(Object.keys(scoped.agent.tools ?? {})).toEqual(["read_file"]); }
    finally { await scoped.close(); }
  } finally { await first.close(); await changed.close(); await rm(root, { recursive: true, force: true }); }
});

test("delegation diagnostics preserve only the finite reason enum", () => {
  const details = sanitizedErrorDetails({ name: "GuardrailTriggeredError", metadata: { delegation: "acceptance", prompt: "private" }, message: "private" });
  expect(details.chain).toEqual([{ kind: "GuardrailTriggeredError", delegation: "acceptance" }]);
  expect(JSON.stringify(details)).not.toContain("private");
  expect(sanitizedErrorDetails({ delegation: "private" }).chain).toEqual([]);
});


test("acceptance diagnostics allow finite causes and discard arbitrary labels", () => {
  for (const acceptanceReason of ["parent_missing_child", "parent_child_failed", "parent_child_marker", "child_missing_read", "child_missing_marker", "child_missing_read_and_marker"] as const) {
    expect(sanitizedErrorDetails({name:"GuardrailTriggeredError", metadata:{delegation:"acceptance", acceptanceReason, output:"private"}}).chain)
      .toEqual([{kind:"GuardrailTriggeredError", delegation:"acceptance", acceptanceReason}]);
  }
  expect(sanitizedErrorDetails({name:"GuardrailTriggeredError", metadata:{acceptanceReason:"private"}}).chain)
    .toEqual([{kind:"GuardrailTriggeredError"}]);
});

test("omitted delegation reports parent_missing_child without leaking output", async () => {
  const root = await mkdtemp(join(tmpdir(), "contract-omission-"));
  const harness = await createHarness({ provider: "qwen", workspace: root, env: {},
    store: createInMemoryAgentRunStore(), subagentProfiles: ["reviewer"], delegationContracts: [contract],
    modelInstance: createMockLanguageModel({streamEvents: [[
      {type:"text-delta",textDelta:"private final response"}, {type:"finish",finishReason:"stop",usage}
    ]]}) });
  let terminal: unknown;
  try {
    const result = await runHarness(harness, {prompt:"Delegate review",scope:harness.config.scope}, {
      onEvent: event => { if (event.type === "error") terminal = event.error; }
    });
    expect(result.status).toBe("failed");
    const details = sanitizedErrorDetails(terminal);
    expect(details.chain.some(entry => entry.acceptanceReason === "parent_missing_child")).toBe(true);
    expect(JSON.stringify(details)).not.toContain("private");
  } finally { await harness.close(); await rm(root,{recursive:true,force:true}); }
});
