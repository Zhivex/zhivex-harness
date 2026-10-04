import { createAgentBudgetCoordinator, wrapLanguageModel, serializeJsonValue, fingerprintAgentHarness, type AgentTokenReservation, type LanguageModel } from "@zhivex-ai/core";
import { Agent, type AgentRunInput, type AgentDefinition } from "@zhivex-ai/agents";
import type { ZhivexHarness } from "./harness.js";
import { HarnessConfigError } from "./errors.js";
import { estimateRequestTokens } from "./model-budget.js";

export interface HarnessSharedBudgetOptions {
  /** Host-supplied conservative bound for each primary model call. */
  modelReservation: AgentTokenReservation;
  /** Defaults to modelReservation. Must fit the child's narrowed allocation. */
  childModelReservation?: AgentTokenReservation;
}
export const validateSharedReservation = (reservation: AgentTokenReservation, limits: AgentTokenReservation) => {
  if (![reservation.inputTokens, reservation.outputTokens, reservation.totalTokens].every(n => Number.isSafeInteger(n) && n > 0) ||
      reservation.totalTokens < reservation.inputTokens + reservation.outputTokens ||
      (["inputTokens", "outputTokens", "totalTokens"] as const).some(k => reservation[k] > limits[k])) {
    throw new HarnessConfigError("Shared budget model reservations must be positive conservative bounds within the authorized token ceilings; total must cover input plus output.");
  }
};
export const boundedSharedModel = (model: LanguageModel, reservation: AgentTokenReservation): LanguageModel => wrapLanguageModel(model, [{
  name: "harness-shared-reservation-preflight-v1",
  async wrapGenerate(context, next) {
    if (estimateRequestTokens(context.input) > reservation.inputTokens) throw new HarnessConfigError("Shared model input reservation is insufficient for the estimated request.");
    context.input.maxTokens = Math.min(context.input.maxTokens ?? reservation.outputTokens, reservation.outputTokens);
    return next();
  },
  async wrapStream(context, next) {
    if (estimateRequestTokens(context.input) > reservation.inputTokens) throw new HarnessConfigError("Shared model input reservation is insufficient for the estimated request.");
    context.input.maxTokens = Math.min(context.input.maxTokens ?? reservation.outputTokens, reservation.outputTokens);
    return next();
  }
}]);

/** Reuse SDK atomic reservations; never create a second token ledger. */
export async function withSharedBudget(harness: ZhivexHarness, runId: string, input: AgentRunInput<LanguageModel>, options: HarnessSharedBudgetOptions) {
  if (harness.config.budget.unlimitedTokens) throw new HarnessConfigError("Shared token budgets require finite token ceilings.");
  const requestedScope = input.state?.scope ?? input.scope ?? harness.config.scope;
  if (requestedScope.tenantId !== harness.config.scope.tenantId || requestedScope.userId !== harness.config.scope.userId || requestedScope.namespace !== harness.config.scope.namespace) {
    throw new HarnessConfigError("Shared budgets use the Harness scope; a different invocation scope is incompatible.");
  }
  if (input.policy?.budgetCoordinator) throw new HarnessConfigError("Use one host-owned shared budget coordinator.");
  const limits = { inputTokens: harness.config.budget.maxInputTokens, outputTokens: harness.config.budget.maxOutputTokens,
    totalTokens: harness.config.budget.maxTotalTokens };
  const reservation = { ...options.modelReservation };
  const childReservation = { ...(options.childModelReservation ?? reservation) };
  validateSharedReservation(reservation, limits);
  const child = harness.config.orchestration.childBudget;
  // SDK child allocations require total >= input + output. Preserve the total
  // authorization and output ceiling by narrowing the input allocation.
  const childLimits = { inputTokens: Math.min(child.maxInputTokens, child.maxTotalTokens - child.maxOutputTokens),
    outputTokens: child.maxOutputTokens, totalTokens: child.maxTotalTokens };
  if (harness.agent.subagents?.length) validateSharedReservation(childReservation, childLimits);
  const models = [harness.agent.model, ...(harness.agent.subagents ?? []).map(s => s.agent.model)];
  if (models.some(model => model.provider === "qwen")) throw new HarnessConfigError("Shared token reservations require a certified output-cap route; Qwen routes are not enabled by this option.");
  const budgetId = `harness:${runId}`;
  const coordinator = createAgentBudgetCoordinator({ store: harness.store, scope: harness.config.scope, budgetId, limits });
  const identity = { modelReservation: reservation, childModelReservation: childReservation };
  const previous = input.state ?? await harness.store.load(runId, harness.config.scope);
  if (previous) {
    if (!previous.budgetCoordinatorId || fingerprintAgentHarness(previous.metadata?.sharedBudgetV1 ?? null) !== fingerprintAgentHarness(identity)) {
      throw new HarnessConfigError("Shared budget resume requires the original reservation policy; legacy usage cannot start a fresh shared pool.");
    }
    const ledgerId = `budget_${fingerprintAgentHarness({ budgetId, scope: harness.config.scope }).slice("sha256:".length)}`;
    const ledger = await harness.store.load(ledgerId, { ...harness.config.scope, namespace: "__zhivex_budget__" });
    if (!ledger || ledger.metadata?.budgetIdentity !== coordinator.id) throw new HarnessConfigError("Shared budget ledger is missing or incompatible; restore the complete state backup before resuming.");
  }
  const subagents = harness.agent.subagents?.map(definition => ({ ...definition, agent: {
    ...definition.agent, model: boundedSharedModel(definition.agent.model, childReservation),
    policy: { ...definition.agent.policy, modelReservation: childReservation,
      budget: { ...definition.agent.policy?.budget, maxInputTokens: childLimits.inputTokens,
        maxOutputTokens: childLimits.outputTokens, maxTotalTokens: childLimits.totalTokens } },
    metadata: { ...definition.agent.metadata,
      ...(definition.agent.metadata?.effectiveRuntime && typeof definition.agent.metadata.effectiveRuntime === "object" && !Array.isArray(definition.agent.metadata.effectiveRuntime)
        ? { effectiveRuntime: { ...definition.agent.metadata.effectiveRuntime, budget: { ...child, maxInputTokens: childLimits.inputTokens } } } : {}),
      sharedBudgetV1: serializeJsonValue({ modelReservation: childReservation, allocation: childLimits }) }
  } as AgentDefinition<LanguageModel> }));
  const agent = new Agent({ ...Object.fromEntries(Object.entries(harness.agent).filter(([, value]) => value !== undefined)),
    model: boundedSharedModel(harness.agent.model, reservation), ...(subagents ? { subagents } : {})
  } as ConstructorParameters<typeof Agent<LanguageModel>>[0]);
  return { harness: { ...harness, agent }, input: { ...input, scope: harness.config.scope,
    policy: { ...input.policy, budgetCoordinator: coordinator, modelReservation: reservation },
    metadata: { ...input.metadata, sharedBudgetV1: serializeJsonValue(identity) }
  } as AgentRunInput<LanguageModel> };
}
