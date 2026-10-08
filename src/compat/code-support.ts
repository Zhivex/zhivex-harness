/** @experimental Explicit host helpers used by the Code terminal product. No terminal implementation. */
export { estimateMessages } from "../context/adaptive-compaction.js";
export { TASK_SOURCE_KEY, taskSources } from "../context/task-memory.js";
export { resolvePackageManager } from "../execution/package-manager.js";
export { runPortableProcess } from "../execution/process-runtime.js";
export { loadModelCatalog } from "../models/catalog-store.js";
export type { CatalogSnapshot } from "../models/catalog-store.js";
export { bundledModelCatalog, catalogModels, modelDescription } from "../models/catalog.js";
export type { ModelCatalog } from "../models/catalog.js";
import { SqliteDatabase } from "../persistence/sqlite-database.js";
/** Read-only diagnostic projection; never exposes a database connection or arbitrary SQL. */
export const inspectCodeStateDatabase = (databasePath: string) => {
  const database = new SqliteDatabase(databasePath, { create: false, readonly: true, strict: true });
  try {
    const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check;
    const tables = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    const sessionVersion = tables.includes("zhivex_cli_session_schema")
      ? database.query<{ version: number }, []>("SELECT version FROM zhivex_cli_session_schema WHERE singleton = 1").get()?.version
      : undefined;
    return { integrity, tables, sessionVersion };
  } finally { database.close(false); }
};
export { modelReasoningEfforts, reasoningEffortSchema } from "../providers/reasoning.js";
export type { HarnessReasoningEffort } from "../providers/reasoning.js";
export { DEFAULT_HARNESS_MAX_STEPS } from "../runtime/config.js";
export { inspectRuntimeDiagnostics } from "../runtime/runtime-diagnostics.js";
export { harnessToolExecution } from "../runtime/tool-execution.js";
export { USAGE_LEDGER_KEY, formatUsageLedger, inspectUsageLedger, usagePricingSchema } from "../runtime/usage-ledger.js";
export { FileChangedWhileReadingError, FileSizeLimitError, UnsafeFileTypeError, readRegularFileNoFollow } from "../workspace/file-security.js";
export { resolvePackageCheckCommand } from "../execution/package-manager.js";
export { nativeTaskSnapshot } from "../runtime/task-acceptance-native.js";
export { TASK_ACCEPTANCE_EVIDENCE_KEY } from "../runtime/task-acceptance-record.js";
export { checkEvidence } from "../client/check-evidence.js";
export { initializeHarnessTaskBudget, inspectHarnessTaskBudget, requestHarnessTaskCancellation, persistHarnessTaskDraft, readHarnessTaskDraft } from "../runtime/task-budget-host.js";
export { TASK_BUDGET_KEY, inspectTaskBudgetSummary } from "../runtime/task-budget.js";

export { createTaskTelemetry } from '../runtime/task-telemetry.js';

export { runHarnessTask } from '../runtime/harness.js';
export type { HarnessTaskRunOptions } from '../runtime/harness.js';
