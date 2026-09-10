import type { AgentRunStore } from "@zhivex-ai/agents/ops";
import { MODEL_BUDGET_KEY, type createModelBudget } from "./model-budget.js";
import { REPAIR_PROGRESS_KEY, type createRepairProgress } from "./repair-progress.js";
import { REPAIR_CONTROLLER_KEY, type createRepairController } from "./repair-controller.js";

export const RUNTIME_DIAGNOSTICS_KEY = "zhivexRuntimeDiagnostics";
/** Decorate the SDK's own writes, never race it with independent revision updates. */
export const runtimeCheckpointStore = (store: AgentRunStore, runId: string,
  budget: ReturnType<typeof createModelBudget>, progress: ReturnType<typeof createRepairProgress>,
  controller: ReturnType<typeof createRepairController>) => new Proxy(store, {
  get(target, key) {
    if (key === "save") return async (...args: Parameters<AgentRunStore["save"]>) => {
      const [state] = args;
      if (state.runId === runId) {
        if (state.status === "completed" && controller.pending()) {
          controller.markIncomplete(); state.status = "failed";
          state.outputText = "Repair incomplete: the candidate has not been verified and delivered.";
          state.error = { message: "REPAIR_INCOMPLETE" };
        }
        state.metadata = { ...state.metadata, [MODEL_BUDGET_KEY]: budget.snapshot(),
          [REPAIR_PROGRESS_KEY]: progress.snapshot(), [REPAIR_CONTROLLER_KEY]: controller.snapshot(),
          [RUNTIME_DIAGNOSTICS_KEY]: { schemaVersion: 1, profile: "repair", budget: { ...budget.stats },
            phase: controller.state.phase, candidate: controller.state.candidate, revision: controller.state.revision,
            checks: controller.state.receipts, contextMeasurements: budget.contextMetrics,
            modelTimings: budget.modelTimings, omittedContextMeasurements: budget.omittedContextMeasurements } };
      }
      return target.save(...args);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  }
});
