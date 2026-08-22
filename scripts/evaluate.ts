import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentApprovalRequest, AgentRunOutput, AgentRunState } from "@zhivex-ai/agents";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createAgentRunLedger, promoteAgentGoldenTrace } from "@zhivex-ai/agents/control-plane";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { McpClient } from "@zhivex-ai/core";

import { createEditProposal } from "../src/edit-contracts.js";
import { createHarness, runHarness } from "../src/harness.js";

interface GoldenCase {
  name: string;
  status: AgentRunState["status"];
  toolCalls: string[];
}

interface GoldenExpectations {
  schemaVersion: 1;
  cases: GoldenCase[];
}

interface EvaluatedCase extends GoldenCase {
  ok: boolean;
  failures: string[];
  durationMs: number;
  steps: number;
  approvals: number;
  goldenTrace: {
    name: string;
    status: AgentRunState["status"];
    toolCalls: string[];
    approvals: number;
  };
}

const workspaceRoot = path.resolve(import.meta.dir, "..");
const expectations = JSON.parse(await readFile(
  path.join(workspaceRoot, "evaluations", "golden-expectations.json"),
  "utf8"
)) as GoldenExpectations;

const temporaryDirectories: string[] = [];
const temporaryWorkspace = async (name: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `zhivex-eval-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const toolCalls = (state: AgentRunState) => state.steps.flatMap((step) =>
  (step.response?.messages ?? []).flatMap((message) => message.parts.flatMap((part) =>
    part.type === "tool-call" ? [part.toolCall.name] : []
  ))
);

const approveAll = (approvals: readonly AgentApprovalRequest[], approve = true) => approvals.map((approval) => ({
  provider: approval.provider,
  approvalRequestId: approval.id,
  approve,
  reason: approve ? "Deterministic evaluation approval." : "Deterministic evaluation denial."
}));

const evaluateState = (
  expected: GoldenCase,
  output: AgentRunOutput,
  startedAt: number,
  extraFailures: string[] = []
): EvaluatedCase => {
  const actualTools = toolCalls(output.state);
  const failures = [...extraFailures];
  if (output.status !== expected.status) {
    failures.push(`Expected status ${expected.status}, got ${output.status}.`);
  }
  if (JSON.stringify(actualTools) !== JSON.stringify(expected.toolCalls)) {
    failures.push(`Expected tools ${expected.toolCalls.join(",")}, got ${actualTools.join(",")}.`);
  }
  if (output.steps.length > output.state.maxSteps) {
    failures.push(`Run exceeded maxSteps ${output.state.maxSteps}.`);
  }
  const durationMs = Date.now() - startedAt;
  if (durationMs > 30_000) {
    failures.push(`Run exceeded deterministic latency budget: ${durationMs}ms.`);
  }
  const ledger = createAgentRunLedger(output.state, {
    includeTimeline: true,
    includeInput: false,
    includeOutput: false,
    includeMetadata: false,
    outputPreviewLength: 0,
    trace: { includeOutputText: false, outputPreviewLength: 0 }
  });
  const goldenTrace = promoteAgentGoldenTrace(ledger, { name: expected.name });
  return {
    ...expected,
    ok: failures.length === 0,
    failures,
    durationMs,
    steps: output.steps.length,
    approvals: output.state.approvalHistory?.length ?? 0,
    goldenTrace: {
      name: goldenTrace.name,
      status: output.status,
      toolCalls: actualTools,
      approvals: output.state.approvalHistory?.length ?? 0
    }
  };
};

const expected = (name: string) => {
  const value = expectations.cases.find((entry) => entry.name === name);
  if (!value) throw new Error(`Missing golden expectation: ${name}.`);
  return value;
};

const analysisOnly = async () => {
  const workspace = await temporaryWorkspace("analysis");
  const harness = await createHarness({
    provider: "openai",
    workspace,
    modelInstance: createMockLanguageModel({
      streamEvents: [[
        { type: "text-delta", textDelta: "analysis complete" },
        { type: "finish", finishReason: "stop" }
      ]]
    }),
    store: createInMemoryAgentRunStore()
  });
  const startedAt = Date.now();
  const output = await runHarness(harness, { prompt: "Analyze without editing" });
  return evaluateState(expected("analysis-only"), output, startedAt);
};

const editAndTest = async () => {
  const workspace = await temporaryWorkspace("edit");
  const script = "bun -e \"console.log('EVAL_OK')\"";
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: script } }), "utf8");
  const changes = [{ path: "evaluated.txt", expectedDigest: null, content: "evaluated\n" }];
  const proposal = createEditProposal({ changes });
  const harness = await createHarness({
    provider: "openai",
    workspace,
    modelInstance: createMockLanguageModel({
      streamEvents: [
        [
          { type: "tool-call", toolCall: { id: "edit-proposal", name: "propose_edits", input: { changes } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "tool-call", toolCall: { id: "edit-apply", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "tool-call", toolCall: { id: "edit-test", name: "run_check", input: { check: "test", expectedScript: script } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "edit validated" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    }),
    store: createInMemoryAgentRunStore()
  });
  const startedAt = Date.now();
  const output = await runHarness(harness, { prompt: "Edit and test" }, {
    resolveApprovals: async (approvals) => approveAll(approvals)
  });
  const content = await readFile(path.join(workspace, "evaluated.txt"), "utf8");
  const checkSucceeded = output.toolResults.some((result) => result.toolName === "run_check" && !result.isError);
  return evaluateState(expected("edit-and-test"), output, startedAt, [
    ...(content === "evaluated\n" ? [] : ["Edited file content did not match."]),
    ...(checkSucceeded ? [] : ["Approved check did not succeed."])
  ]);
};

const deniedApproval = async () => {
  const workspace = await temporaryWorkspace("denied");
  const changes = [{ path: "denied.txt", expectedDigest: null, content: "must not exist\n" }];
  const proposal = createEditProposal({ changes });
  const store = createInMemoryAgentRunStore();
  const harness = await createHarness({
    provider: "openai",
    workspace,
    modelInstance: createMockLanguageModel({
      streamEvents: [
        [
          { type: "tool-call", toolCall: { id: "deny-proposal", name: "propose_edits", input: { changes } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "tool-call", toolCall: { id: "deny-apply", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "denied safely" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    }),
    store
  });
  const startedAt = Date.now();
  let output: AgentRunOutput;
  try {
    output = await runHarness(harness, { runId: "evaluation-denied", prompt: "Attempt denied edit" }, {
      resolveApprovals: async (approvals) => approveAll(approvals, false)
    });
  } catch (error) {
    const persisted = await store.load("evaluation-denied");
    if (!persisted) throw error;
    output = {
      status: persisted.status,
      outputText: persisted.outputText,
      messages: persisted.messages,
      steps: persisted.steps,
      toolResults: persisted.toolResults,
      state: persisted,
      usage: persisted.usage,
      error: { message: error instanceof Error ? error.message : String(error) }
    };
  }
  const absent = await readFile(path.join(workspace, "denied.txt"), "utf8")
    .then(() => false, () => true);
  return evaluateState(expected("denied-approval"), output, startedAt, absent ? [] : ["Denied edit mutated the workspace."]);
};

const failureRecovery = async () => {
  const workspace = await temporaryWorkspace("recovery");
  const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
  const changes = [{ path: "recovered.txt", expectedDigest: null, content: "once\n" }];
  const proposal = createEditProposal({ changes });
  const first = await createHarness({
    provider: "openai",
    workspace,
    stateDirectory,
    modelInstance: createMockLanguageModel({
      streamEvents: [
        [
          { type: "tool-call", toolCall: { id: "recover-proposal", name: "propose_edits", input: { changes } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "tool-call", toolCall: { id: "recover-apply", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } },
          { type: "finish", finishReason: "tool-calls" }
        ]
      ]
    })
  });
  const startedAt = Date.now();
  const waiting = await runHarness(first, {
    runId: "evaluation-recovery",
    prompt: "Recover after restart",
    scope: first.config.scope,
    idempotencyKey: "evaluation-recovery"
  });
  await first.close();

  const second = await createHarness({
    provider: "openai",
    workspace,
    stateDirectory,
    modelInstance: createMockLanguageModel({
      streamEvents: [[
        { type: "text-delta", textDelta: "recovered once" },
        { type: "finish", finishReason: "stop" }
      ]]
    })
  });
  const checkpoint = await second.store.load(waiting.state.runId, second.config.scope);
  if (!checkpoint) throw new Error("Recovery checkpoint was not persisted.");
  const output = await runHarness(second, {
    state: checkpoint,
    approvals: approveAll(checkpoint.pendingApprovals)
  });
  const journal = await second.store.listToolCalls?.(output.state.runId, second.config.scope) ?? [];
  await second.close();
  const content = await readFile(path.join(workspace, "recovered.txt"), "utf8");
  const applyEntries = journal.filter((entry) => entry.toolName === "apply_patch" && entry.status === "completed");
  return evaluateState(expected("failure-recovery"), output, startedAt, [
    ...(content === "once\n" ? [] : ["Recovered content did not match."]),
    ...(applyEntries.length === 1 ? [] : [`Expected one completed apply journal entry, got ${applyEntries.length}.`])
  ]);
};

const providerSwitch = async () => {
  const workspace = await temporaryWorkspace("providers");
  let representative: AgentRunOutput | undefined;
  const failures: string[] = [];
  const startedAt = Date.now();
  for (const provider of ["meta", "qwen", "openai"] as const) {
    const harness = await createHarness({
      provider,
      workspace,
      modelInstance: createMockLanguageModel({
        provider,
        modelId: `${provider}-mock`,
        streamEvents: [[
          { type: "text-delta", textDelta: "portable" },
          { type: "finish", finishReason: "stop" }
        ]]
      }),
      store: createInMemoryAgentRunStore()
    });
    const output = await runHarness(harness, { prompt: "Portable response" });
    representative = output;
    if (output.status !== "completed" || output.outputText !== "portable") {
      failures.push(`${provider} did not preserve the portable contract.`);
    }
  }
  if (!representative) throw new Error("Provider switch evaluation produced no runs.");
  return evaluateState(expected("provider-switch"), representative, startedAt, failures);
};

const governedMcp = async () => {
  const workspace = await temporaryWorkspace("mcp");
  let calls = 0;
  const mcpClient: McpClient = {
    async listTools() {
      return { tools: [{
        name: "lookup",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      }] };
    },
    async callTool() {
      calls += 1;
      return { content: [{ type: "text", text: "bounded evidence" }] };
    }
  };
  const harness = await createHarness({
    provider: "openai",
    workspace,
    subagentProfiles: [],
    mcpConfiguration: {
      schemaVersion: 1,
      servers: [{
        name: "remote",
        transport: "http",
        url: "https://mcp.example.invalid/rpc",
        includeTools: ["lookup"],
        permissions: ["read", "network"]
      }]
    },
    mcpClients: { remote: mcpClient },
    modelInstance: createMockLanguageModel({
      streamEvents: [
        [
          { type: "tool-call", toolCall: { id: "eval-mcp", name: "remote_lookup", input: {} } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "MCP evaluated" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    }),
    store: createInMemoryAgentRunStore()
  });
  const startedAt = Date.now();
  const output = await runHarness(harness, { prompt: "Use governed MCP" }, {
    resolveApprovals: async (approvals) => approveAll(approvals)
  });
  await harness.close();
  return evaluateState(expected("governed-mcp"), output, startedAt, [
    ...(calls === 1 ? [] : [`Expected one MCP call, got ${calls}.`])
  ]);
};

const boundedSubagent = async () => {
  const workspace = await temporaryWorkspace("subagent");
  const harness = await createHarness({
    provider: "openai",
    workspace,
    subagentProfiles: ["reviewer"],
    modelInstance: createMockLanguageModel({
      streamEvents: [
        [
          { type: "tool-call", toolCall: { id: "eval-reviewer", name: "delegate_reviewer", input: { prompt: "Review the boundary" } } },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "review complete" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    }),
    subagentModels: {
      reviewer: createMockLanguageModel({
        responses: [{
          messages: [{ role: "assistant", parts: [{ type: "text", text: "independent evidence" }] }],
          text: "independent evidence",
          finishReason: "stop"
        }]
      })
    },
    store: createInMemoryAgentRunStore()
  });
  const startedAt = Date.now();
  const output = await runHarness(harness, { prompt: "Delegate review" });
  await harness.close();
  const child = output.state.childRuns?.[0];
  return evaluateState(expected("bounded-subagent"), output, startedAt, [
    ...(child?.agentId === "zhivex-harness-reviewer" ? [] : ["Expected reviewer child run."]),
    ...(child?.status === "completed" ? [] : ["Reviewer child did not complete."])
  ]);
};

let results: EvaluatedCase[] = [];
try {
  results = [
    await analysisOnly(),
    await editAndTest(),
    await deniedApproval(),
    await failureRecovery(),
    await providerSwitch(),
    await governedMcp(),
    await boundedSubagent()
  ];
} finally {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
}

const report = {
  schemaVersion: 1,
  kind: "harness-evaluation-report",
  ok: results.every((result) => result.ok),
  total: results.length,
  passed: results.filter((result) => result.ok).length,
  failed: results.filter((result) => !result.ok).length,
  cases: results
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
