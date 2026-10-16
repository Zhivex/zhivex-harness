import type { AgentRunState, AgentRunStore, AgentStoreScope } from "@zhivex-ai/core";
import { HarnessStateConflictError } from "./errors.js";

/** SDK coordinators address ledgers with this namespace. The durable owner appends the source namespace. */
export const BUDGET_LEDGER_NAMESPACE = "__zhivex_budget__";
export const BUDGET_OWNER_NAMESPACE_KEY = "budgetOwnerNamespace";

export const isReservedBudgetNamespace = (namespace: string | undefined) =>
  namespace === BUDGET_LEDGER_NAMESPACE || (namespace?.startsWith(`${BUDGET_LEDGER_NAMESPACE}:`) ?? false);

/** Bind the caller's full namespace into the ledger owner. Collapsing every namespace to the SDK marker lets one tenant read another's ledger by run id. */
export const budgetLedgerNamespace = (namespace: string) => {
  if (!namespace || isReservedBudgetNamespace(namespace)) {
    throw new HarnessStateConflictError("The budget ledger namespace is reserved.");
  }
  return `${BUDGET_LEDGER_NAMESPACE}:${namespace}`;
};

export const budgetLedgerScope = (scope: Pick<AgentStoreScope, "tenantId" | "userId" | "namespace">): AgentStoreScope => {
  if (!scope.namespace) throw new HarnessStateConflictError("The budget ledger requires the source namespace.");
  return {
    tenantId: scope.tenantId,
    ...(scope.userId ? { userId: scope.userId } : {}),
    namespace: budgetLedgerNamespace(scope.namespace)
  };
};

const sameIdentity = (left: AgentStoreScope | undefined, right: AgentStoreScope) =>
  left?.tenantId === right.tenantId && (left.userId ?? undefined) === (right.userId ?? undefined);

/** Translate the SDK's collapsed namespace onto the bound owner before the file or SQLite store. */
export const bindBudgetLedgerStore = (primary: AgentRunStore, scope: AgentStoreScope, budget: AgentRunStore = primary): AgentRunStore => {
  const bound = budgetLedgerScope(scope);
  const ownerNamespace = scope.namespace!;
  const isSdkBudget = (value: AgentStoreScope | undefined) =>
    sameIdentity(value, bound) && value?.namespace === BUDGET_LEDGER_NAMESPACE;
  const isBoundBudget = (value: AgentStoreScope | undefined) =>
    sameIdentity(value, bound) && value?.namespace === bound.namespace;
  const assertId = (id: string) => {
    if (!/^budget_[a-f0-9]{64}$/.test(id)) throw new HarnessStateConflictError("Invalid budget ledger identity.");
  };
  const bindState = (state: AgentRunState): AgentRunState => {
    const metadata = { ...(state.metadata ?? {}) };
    const owner = metadata[BUDGET_OWNER_NAMESPACE_KEY];
    if (owner !== undefined && owner !== ownerNamespace) {
      throw new HarnessStateConflictError("Budget ledger is bound to another namespace.");
    }
    return {
      ...state,
      scope: bound,
      metadata: { ...metadata, [BUDGET_OWNER_NAMESPACE_KEY]: ownerNamespace }
    };
  };
  const assertStored = (state: AgentRunState | undefined) => {
    if (!state) return state;
    const owner = state.metadata?.[BUDGET_OWNER_NAMESPACE_KEY];
    if (state.scope?.namespace !== bound.namespace || owner !== ownerNamespace) {
      throw new HarnessStateConflictError("Budget ledger is not bound to this namespace.");
    }
    return state;
  };
  return {
    ...primary,
    load: async (id, requestedScope) => {
      if (!isSdkBudget(requestedScope) && !isBoundBudget(requestedScope)) return primary.load(id, requestedScope);
      assertId(id);
      return assertStored(await budget.load(id, bound));
    },
    save: async (state, options) => {
      if (!isSdkBudget(state.scope) && !isBoundBudget(state.scope)) return primary.save(state, options);
      assertId(state.runId);
      if (state.provider !== "zhivex" || state.modelId !== "budget-coordinator" || state.metadata?.budgetCoordinator !== true) {
        throw new HarnessStateConflictError("Only SDK budget ledger states may use the reserved namespace.");
      }
      return budget.save(bindState(state), options);
    }
  };
};
