import { type AgentRunInput, type AgentRunState } from "@zhivex-ai/agents";
import { type HarnessConfig, type HarnessConfigInput, type HarnessSubagentProfile } from "../runtime/config.js";
import { resolveHarnessModelRoutes, serializeHarnessModelRoutes, type HarnessModelRoute } from "../providers/routing.js";
import { type CliOptions } from "./arguments.js";

export const HARNESS_RESUME_METADATA_KEY = "zhivexHarnessResume" as const;

export const HARNESS_RESUME_METADATA_SCHEMA_VERSION = 1 as const;

export const harnessConfigInput = (config: HarnessConfig): HarnessConfigInput => ({
  schemaVersion: config.schemaVersion,
  provider: config.provider,
  model: config.model,
  workspace: config.workspace,
  stateDirectory: config.stateDirectory,
  storeBackend: config.storeBackend,
  tenantId: config.scope.tenantId,
  ...(config.scope.userId ? { userId: config.scope.userId } : {}),
  ...(config.scope.namespace ? { namespace: config.scope.namespace } : {}),
  agentProfile: config.agentProfile,
  maxSteps: config.maxSteps,
  timeoutMs: config.timeoutMs,
  maxToolCalls: config.budget.maxToolCalls,
  maxToolErrors: config.budget.maxToolErrors,
  ...(config.budget.unlimitedTokens !== undefined ? { unlimitedTokens: config.budget.unlimitedTokens } : {}),
  maxInputTokens: config.budget.maxInputTokens,
  maxOutputTokens: config.budget.maxOutputTokens,
  maxTotalTokens: config.budget.maxTotalTokens,
  ...(config.costBudget
    ? {
        maxCostUsd: config.costBudget.maxCostUsd,
        inputCostPerMillion: config.costBudget.inputCostPer1kTokens * 1_000,
        outputCostPerMillion: config.costBudget.outputCostPer1kTokens * 1_000
      }
    : {}),
  compactionMaxMessages: config.compaction.maxMessages,
  compactionMaxEstimatedInputTokens: config.compaction.maxEstimatedInputTokens,
  compactionKeepRecentMessages: config.compaction.keepRecentMessages,
  allowedChecks: [...config.allowedChecks],
  requiredCapabilities: [...config.requiredCapabilities],
  subagentProfiles: [...config.orchestration.profiles],
  subagentMaxSteps: config.orchestration.childBudget.maxSteps,
  subagentMaxToolCalls: config.orchestration.childBudget.maxToolCalls,
  subagentMaxToolErrors: config.orchestration.childBudget.maxToolErrors,
  subagentMaxInputTokens: config.orchestration.childBudget.maxInputTokens,
  subagentMaxOutputTokens: config.orchestration.childBudget.maxOutputTokens,
  subagentMaxTotalTokens: config.orchestration.childBudget.maxTotalTokens,
  subagentTimeoutMs: config.orchestration.childTimeoutMs,
  maxParallelReviews: config.orchestration.maxParallelReviews,
  projectContext: config.context.enabled,
  contextConfigPath: config.context.configPath,
  executionBackend: config.execution.backend,
  ...(config.execution.backend === "oci"
    ? {
        ociRuntime: config.execution.runtime,
        ociImage: config.execution.image,
        ociAllowedCommands: [...config.execution.allowedCommands],
        ociShellMode: config.execution.shellMode,
        ociMaxProcessRuntimeMs: config.execution.maxProcessRuntimeMs,
        ociMaxProcessOutputBytes: config.execution.maxProcessOutputBytes,
        ociMaxMemoryMb: config.execution.maxMemoryMb,
        ociMaxPids: config.execution.maxPids,
        ociMaxCpus: config.execution.maxCpus,
        ociMaxWorkspaceBytes: config.execution.maxWorkspaceBytes,
        ociMaxFileWriteBytes: config.execution.maxFileWriteBytes,
        ociTmpfsMb: config.execution.tmpfsMb
      }
    : {}),
  ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {})
});

export const persistedCliOptions = (input: HarnessConfigInput | undefined): Partial<CliOptions> => input
  ? {
      ...input,
      ...(input.allowedChecks ? { allowedChecks: [...input.allowedChecks] } : {}),
      ...(input.requiredCapabilities ? { requiredCapabilities: [...input.requiredCapabilities] } : {}),
      ...(input.subagentProfiles
        ? { subagentProfiles: [...input.subagentProfiles] as HarnessSubagentProfile[] }
        : {}),
      ...(input.ociAllowedCommands ? { ociAllowedCommands: [...input.ociAllowedCommands] } : {})
    } as Partial<CliOptions>
  : {};

export const createHarnessResumeMetadata = (
  config: HarnessConfig,
  routes?: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>
): NonNullable<AgentRunInput["metadata"]> => ({
  [HARNESS_RESUME_METADATA_KEY]: JSON.parse(JSON.stringify({
    schemaVersion: HARNESS_RESUME_METADATA_SCHEMA_VERSION,
    config,
    ...(routes && routes.size > 0 ? { routes: serializeHarnessModelRoutes(routes) } : {})
  }))
});

const readHarnessResumeDocument = (state: Pick<AgentRunState, "metadata">) => {
  const value = state.metadata?.[HARNESS_RESUME_METADATA_KEY];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted harness resume metadata is invalid.");
  }
  const document = value as { schemaVersion?: unknown; config?: unknown; routes?: unknown };
  if (
    document.schemaVersion !== HARNESS_RESUME_METADATA_SCHEMA_VERSION ||
    !document.config ||
    typeof document.config !== "object" ||
    Array.isArray(document.config)
  ) {
    throw new Error("Persisted harness resume metadata is invalid.");
  }
  return document;
};

export const readHarnessResumeConfig = (
  state: Pick<AgentRunState, "metadata">
): HarnessConfigInput | undefined => {
  const document = readHarnessResumeDocument(state);
  if (!document) return undefined;
  try {
    return harnessConfigInput(document.config as HarnessConfig);
  } catch {
    throw new Error("Persisted harness resume metadata is invalid.");
  }
};

export const readHarnessResumeRoutes = (
  state: Pick<AgentRunState, "metadata">
) => {
  const document = readHarnessResumeDocument(state);
  if (!document?.routes) return resolveHarnessModelRoutes();
  if (typeof document.routes !== "object" || Array.isArray(document.routes)) {
    throw new Error("Persisted harness routing metadata is invalid.");
  }
  try {
    const values = Object.entries(document.routes as Record<string, unknown>).map(([profile, target]) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("invalid");
      const route = target as { provider?: unknown; model?: unknown };
      if (typeof route.provider !== "string" || typeof route.model !== "string") throw new Error("invalid");
      return `${profile}=${route.provider}:${route.model}`;
    });
    return resolveHarnessModelRoutes(values);
  } catch {
    throw new Error("Persisted harness routing metadata is invalid.");
  }
};

const shellArgument = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const resumeCommand = (runId: string, config: HarnessConfig, approve = true) => [
  "zhivex-harness",
  "resume",
  shellArgument(runId),
  approve ? "--approve" : "--deny",
  "--workspace",
  shellArgument(config.workspace),
  "--state-dir",
  shellArgument(config.stateDirectory),
  "--store",
  config.storeBackend,
  "--tenant",
  shellArgument(config.scope.tenantId),
  ...(config.scope.userId ? ["--user", shellArgument(config.scope.userId)] : []),
  ...(config.scope.namespace ? ["--namespace", shellArgument(config.scope.namespace)] : [])
].join(" ");
