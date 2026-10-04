import { createAgentBudgetCoordinator, fingerprintAgentHarness, serializeJsonValue, type AgentTokenReservation } from "@zhivex-ai/core";
import type { AgentDefinition, LanguageModel, AgentRunState } from "@zhivex-ai/agents";
import type { AgentRunStore } from "@zhivex-ai/agents/ops";
import type { HarnessConfig } from "./config.js";
import { HarnessConfigError, HarnessStateConflictError } from "./errors.js";
import { boundedSharedModel, validateSharedReservation, type HarnessSharedBudgetOptions } from "./shared-budget.js";

type Runtime = { config: HarnessConfig; store: AgentRunStore };
export type ReviewBudgetStatus = "ready" | "reserved" | "unknown" | "missing";
const ledgerLocation = (runtime: Runtime, groupId: string) => ({
  runId: `budget_${fingerprintAgentHarness({ budgetId: `harness-review:${groupId}`, scope: runtime.config.scope }).slice("sha256:".length)}`,
  scope: { ...runtime.config.scope, namespace: "__zhivex_budget__" }
});
export async function reviewBudgetStatus(runtime: Runtime, groupId: string, identity: string): Promise<ReviewBudgetStatus> {
  const location = ledgerLocation(runtime, groupId);
  const ledger = await runtime.store.load(location.runId, location.scope);
  if (!ledger || ledger.metadata?.budgetIdentity !== identity) return "missing";
  const entries = ledger.metadata?.allocations;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new HarnessStateConflictError("Invalid shared review budget ledger.");
  const statuses = Object.values(entries).map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !["reserved", "unknown", "confirmed"].includes(String(entry.status))) {
      throw new HarnessStateConflictError("Invalid shared review budget allocation.");
    }
    return entry.status;
  });
  return statuses.includes("unknown") ? "unknown" : statuses.includes("reserved") ? "reserved" : "ready";
}

/** One SDK pool for all review member calls; local child limits remain enforced. */
export function sharedReviewBudget(runtime: Runtime, groupId: string, agents: AgentDefinition<LanguageModel>[], options: HarnessSharedBudgetOptions) {
  if (runtime.config.budget.unlimitedTokens) throw new HarnessConfigError("Shared review budgets require finite token ceilings.");
  if (agents.some(agent => agent.model.provider === "qwen" || agent.policy?.budgetCoordinator)) {
    throw new HarnessConfigError("Shared review budgets require one host-owned coordinator and certified output-cap routes; Qwen is not enabled.");
  }
  const limits = { inputTokens: runtime.config.budget.maxInputTokens, outputTokens: runtime.config.budget.maxOutputTokens, totalTokens: runtime.config.budget.maxTotalTokens };
  validateSharedReservation(options.modelReservation, limits);
  const child = runtime.config.orchestration.childBudget;
  const allocation = { inputTokens: Math.min(child.maxInputTokens, child.maxTotalTokens - child.maxOutputTokens), outputTokens: child.maxOutputTokens, totalTokens: child.maxTotalTokens };
  const reservation = { ...(options.childModelReservation ?? options.modelReservation) };
  validateSharedReservation(reservation, allocation);
  const coordinator = createAgentBudgetCoordinator({ store: runtime.store, scope: runtime.config.scope, budgetId: `harness-review:${groupId}`, limits });
  const identity = { coordinatorId: coordinator.id, modelReservation: { ...options.modelReservation }, childModelReservation: reservation, allocation };
  const definitions: AgentDefinition<LanguageModel>[] = agents.map(agent => ({ ...agent, model: boundedSharedModel(agent.model, reservation),
    policy: { ...agent.policy, budgetCoordinator: coordinator, modelReservation: reservation,
      budget: { ...agent.policy?.budget, maxInputTokens: allocation.inputTokens, maxOutputTokens: allocation.outputTokens, maxTotalTokens: allocation.totalTokens } },
    metadata: { ...agent.metadata,
      ...(agent.metadata?.effectiveRuntime && typeof agent.metadata.effectiveRuntime === "object" && !Array.isArray(agent.metadata.effectiveRuntime)
        ? { effectiveRuntime: { ...agent.metadata.effectiveRuntime, budget: { ...child, maxInputTokens: allocation.inputTokens } } } : {}),
      sharedBudgetV1: serializeJsonValue(identity) }
  }));
  return { identity, agents: definitions,
    async initialize(previous: AgentRunState | undefined) {
      if (previous && (previous.budgetCoordinatorId !== coordinator.id || fingerprintAgentHarness(previous.metadata?.sharedBudgetV1 ?? null) !== fingerprintAgentHarness(identity))) {
        throw new HarnessStateConflictError("Shared review budget resume requires the original reservation policy; legacy groups cannot start a fresh pool.");
      }
      const status = await reviewBudgetStatus(runtime, groupId, coordinator.id);
      if (status === "missing") {
        if (previous) throw new HarnessStateConflictError("Shared review budget ledger is missing or incompatible; restore the complete backup.");
        // Durable zero-use initialization precedes the root claim. A cut after
        // root creation must never be mistaken for an unused, replaceable pool.
        const id = `initialize:${groupId}`;
        const zero: AgentTokenReservation = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        await coordinator.reserve(id, zero);
        await coordinator.settle(id, zero);
      }
    },
    async requireReady() {
      const status = await reviewBudgetStatus(runtime, groupId, coordinator.id);
      if (status !== "ready") throw new HarnessStateConflictError(`Shared review budget is ${status}; unresolved reservations require reconciliation before further execution.`);
    }
  };
}
