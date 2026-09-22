import { inspectRuntimeDiagnostics } from "../runtime/runtime-diagnostics.js";
import { formatUsageLedger } from "../runtime/usage-ledger.js";
import { resolveHarnessConfig } from "../runtime/config.js";
import {
  cancelHarnessRun,
  cleanupHarnessRuns,
  inspectHarnessRun,
  listHarnessRuns,
  openHarnessPersistence
} from "../persistence/operations.js";
import { validateStateDirectory } from "../persistence/state-directory.js";
import { CliOciRuntimeAdapter, cleanupHarnessExecutionArtifacts } from "../execution/execution-environment.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

const printRunsDocument = (document: unknown, json: boolean) => {
  if (json || !document || typeof document !== "object") {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const record = document as Record<string, unknown>;
  if (record.kind === "run-list" && Array.isArray(record.runs)) {
    for (const run of record.runs as Array<Record<string, unknown>>) {
      process.stdout.write(
        `${String(run.runId).padEnd(30)} ${String(run.status).padEnd(18)} ${String(run.provider)}/${String(run.model)} ${String(run.steps)} steps\n`
      );
    }
    if (typeof record.nextCursor === "string") {
      process.stderr.write(`next cursor: ${record.nextCursor}\n`);
    }
    return;
  }
  if (record.kind === "run-inspection") {
    const run = record.run as Record<string, unknown>;
    process.stdout.write(
      `${String(run.runId)} · ${String(run.status)} · ${String(run.provider)}/${String(run.model)} · ${String(run.steps)} steps · ${String(run.toolCalls)} tools\n`
    );
    const diagnostics = inspectRuntimeDiagnostics(record.runtimeDiagnostics);
    if (record.usageLedger) process.stdout.write(formatUsageLedger(record.usageLedger) + "\n");
    if (diagnostics) process.stdout.write(
      `repair: ${diagnostics.phase} · revision ${diagnostics.revision} · ${diagnostics.budget.inputTokens} input / ${diagnostics.budget.outputTokens} output tokens · ${diagnostics.budget.modelCalls} model calls` +
      `${diagnostics.budget.usageComplete ? "" : " · usage incomplete"}${diagnostics.budget.stopReason ? ` · ${diagnostics.budget.stopReason}` : ""}\n`
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
};

export const manageRuns = async (options: CliOptions) => {
  const config = resolveHarnessConfig(options);
  await validateStateDirectory(config.workspace, config.stateDirectory);
  const persistence = await openHarnessPersistence(config);
  try {
    let document: unknown;
    switch (options.runsCommand) {
      case "list":
        document = await listHarnessRuns(persistence.store, config, {
          ...(options.statuses ? { statuses: options.statuses } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {})
        });
        break;
      case "inspect":
        document = await inspectHarnessRun(persistence.store, config, options.runId!);
        break;
      case "export": {
        const inspection = await inspectHarnessRun(persistence.store, config, options.runId!);
        document = { ...inspection, kind: "run-export" as const };
        break;
      }
      case "cancel":
        document = await cancelHarnessRun(persistence.store, config, options.runId!, {
          ...(options.reason ? { reason: options.reason } : {}),
          cascade: options.cascade,
          final: options.final
        });
        break;
      case "cleanup":
        document = await cleanupHarnessRuns(persistence.store, config, {
          before: options.before!,
          ...(options.statuses ? { statuses: options.statuses } : {}),
          ...(options.limit ? { limit: options.limit } : {})
        });
        document = {
          ...(document as Record<string, unknown>),
          executionArtifacts: await cleanupHarnessExecutionArtifacts(config.stateDirectory, options.before!, { workspace: config.workspace, scope: config.scope }),
          ...(config.execution.backend === "oci"
            ? {
                orphanContainersRemoved: await new CliOciRuntimeAdapter(
                  config.execution.runtime
                ).cleanupOrphans()
              }
            : {})
        };
        break;
      default:
        throw new CliUsageError("runs requires one of: list, inspect, cancel, cleanup, export.");
    }
    printRunsDocument(document, options.json);
  } finally {
    persistence.close();
  }
};
