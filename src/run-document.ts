import { getAgentBudgetStatus, type AgentRunOutput } from "@zhivex-ai/agents";
import { estimateAgentRunCost, type TokenPricing } from "@zhivex-ai/agents/ops";
import { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import { USAGE_LEDGER_KEY, inspectUsageLedger } from "./usage-ledger.js";
import type { ZhivexHarness } from "./harness.js";

const costPricing = (harness: ZhivexHarness): TokenPricing | undefined => harness.config.costBudget
  ? {
      inputCostPer1kTokens: harness.config.costBudget.inputCostPer1kTokens,
      outputCostPer1kTokens: harness.config.costBudget.outputCostPer1kTokens,
      currency: "USD"
    }
  : undefined;

export const runResultDocument = (result: AgentRunOutput, harness: ZhivexHarness) => ({
  schemaVersion: CLI_JSON_SCHEMA_VERSION,
  kind: "run-result" as const,
  runId: result.state.runId,
  status: result.status,
  provider: result.state.provider,
  model: result.state.modelId,
  output: result.outputText,
  steps: result.steps.length,
  toolCalls: result.toolResults.length,
  mutations: harness.workspace.mutationAudit(),
  pendingApprovals: result.state.pendingApprovals.map((approval) => ({
    id: approval.id,
    kind: approval.kind ?? "provider",
    name: approval.name,
    arguments: approval.arguments,
    ...(approval.childRunId ? { childRunId: approval.childRunId } : {}),
    ...(approval.childAgentId ? { childAgentId: approval.childAgentId } : {})
  })),
  children: (result.state.childRuns ?? []).map((child) => ({
    runId: child.runId,
    agentId: child.agentId,
    toolName: child.toolName,
    status: child.status,
    steps: child.steps,
    toolCalls: child.toolCalls,
    toolErrors: child.toolErrors,
    usage: child.usage
  })),
  usage: result.usage,
  ...(result.state.metadata?.[USAGE_LEDGER_KEY] ? { usageLedger: inspectUsageLedger(result.state.metadata[USAGE_LEDGER_KEY]) } : {}),
  budget: getAgentBudgetStatus(result.state, harness.config.budget, result),
  ...(harness.config.costBudget
    ? {
        costBudget: {
          limitUsd: harness.config.costBudget.maxCostUsd,
          estimate: estimateAgentRunCost(result.state, costPricing(harness))
        }
      }
    : {}),
  scope: result.state.scope,
  capabilities: harness.capabilities,
  orchestration: {
    profiles: harness.config.orchestration.profiles,
    childBudget: harness.config.orchestration.childBudget,
    mcpServers: harness.mcpConfiguration.servers.map((server) => server.name)
  },
  execution: harness.executionEnvironment
    ? {
        backend: "oci" as const,
        binding: result.state.executionEnvironment,
        image: harness.executionEnvironment.image
      }
    : { backend: "none" as const },
  store: {
    backend: harness.config.storeBackend,
    stateDirectory: harness.config.stateDirectory,
    migration: harness.persistence?.migration
  },
  stateDirectory: harness.config.stateDirectory
});

