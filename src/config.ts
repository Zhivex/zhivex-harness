import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import type { LanguageModel } from "@zhivex-ai/agents";
import type { AgentStoreScope } from "@zhivex-ai/agents/ops";
import {
  BUILTIN_PROVIDER_REGISTRATIONS,
  DEFAULT_PROVIDER_REGISTRY,
  PROVIDERS,
  PROVIDER_DESCRIPTORS,
  createProviderRegistry,
  type BuiltInHarnessProvider,
  type HarnessProvider,
  type HarnessProviderRegistry,
  type ProviderAvailability,
  type ProviderCapability,
  type ProviderCredentials,
  type ProviderDescriptor,
  type ProviderDiagnosticsDescriptor,
  type ProviderEnumDiagnostic,
  type ProviderModelFactory,
  type ProviderModelFactoryContext,
  type ProviderPresenceDiagnostic,
  type ProviderRegistration,
  type ProviderSupport
} from "./providers.js";

export const DEFAULT_ALLOWED_CHECKS = ["test", "typecheck", "lint", "build"] as const;

export const HARNESS_CONFIG_SCHEMA_VERSION = 4 as const;

export const HARNESS_STORE_BACKENDS = ["sqlite", "file"] as const;

export const HARNESS_EXECUTION_BACKENDS = ["none", "oci"] as const;
export const HARNESS_OCI_RUNTIMES = ["docker", "podman"] as const;
export const HARNESS_EXECUTION_POLICY_VERSION = "2026-08-20-v2" as const;

export const DEFAULT_OCI_EXECUTION = {
  runtime: "docker",
  image: "oven/bun:1.3.7-slim",
  allowedCommands: ["bun"],
  maxProcessRuntimeMs: 120_000,
  maxProcessOutputBytes: 20_000,
  maxMemoryMb: 1_024,
  maxPids: 128,
  maxCpus: 2,
  maxWorkspaceBytes: 64 * 1024 * 1024,
  maxFileWriteBytes: 1024 * 1024,
  tmpfsMb: 256
} as const;

export const HARNESS_REQUIRED_CAPABILITIES = [
  "streaming",
  "tools",
  "structured-output",
  "parallel-tools",
  "reasoning",
  "web-search"
] as const;

export const HARNESS_SUBAGENT_PROFILES = [
  "explorer",
  "implementer",
  "tester",
  "reviewer"
] as const;

export const DEFAULT_HARNESS_BUDGET = {
  maxToolCalls: 32,
  maxToolErrors: 4,
  maxInputTokens: 100_000,
  maxOutputTokens: 30_000,
  maxTotalTokens: 120_000,
  includeChildRuns: true
} as const;

export const DEFAULT_HARNESS_COMPACTION = {
  maxMessages: 60,
  maxEstimatedInputTokens: 40_000,
  keepRecentMessages: 12
} as const;

export const DEFAULT_SUBAGENT_BUDGET = {
  maxSteps: 8,
  maxToolCalls: 16,
  maxToolErrors: 3,
  maxInputTokens: 30_000,
  maxOutputTokens: 8_000,
  maxTotalTokens: 36_000,
  includeChildRuns: false
} as const;

export type HarnessStoreBackend = (typeof HARNESS_STORE_BACKENDS)[number];
export type HarnessExecutionBackend = (typeof HARNESS_EXECUTION_BACKENDS)[number];
export type HarnessOciRuntime = (typeof HARNESS_OCI_RUNTIMES)[number];
export type HarnessRequiredCapability = (typeof HARNESS_REQUIRED_CAPABILITIES)[number];
export type HarnessSubagentProfile = (typeof HARNESS_SUBAGENT_PROFILES)[number];

export interface HarnessBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxToolErrors: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  includeChildRuns: boolean;
}

export interface HarnessCompactionConfig {
  maxMessages: number;
  maxEstimatedInputTokens: number;
  keepRecentMessages: number;
}

export interface HarnessCostBudget {
  maxCostUsd: number;
  inputCostPer1kTokens: number;
  outputCostPer1kTokens: number;
}

export interface HarnessOrchestrationConfig {
  profiles: readonly HarnessSubagentProfile[];
  childBudget: HarnessBudget;
  childTimeoutMs: number;
  maxParallelReviews: number;
}

export type HarnessExecutionConfig =
  | { backend: "none" }
  | {
      backend: "oci";
      policyVersion: typeof HARNESS_EXECUTION_POLICY_VERSION;
      runtime: HarnessOciRuntime;
      image: string;
      allowedCommands: readonly string[];
      maxProcessRuntimeMs: number;
      maxProcessOutputBytes: number;
      maxMemoryMb: number;
      maxPids: number;
      maxCpus: number;
      maxWorkspaceBytes: number;
      maxFileWriteBytes: number;
      tmpfsMb: number;
    };

export interface HarnessConfig {
  schemaVersion: typeof HARNESS_CONFIG_SCHEMA_VERSION;
  provider: HarnessProvider;
  model: string;
  workspace: string;
  stateDirectory: string;
  storeBackend: HarnessStoreBackend;
  scope: AgentStoreScope;
  maxSteps: number;
  timeoutMs: number;
  budget: HarnessBudget;
  costBudget?: HarnessCostBudget;
  compaction: HarnessCompactionConfig;
  allowedChecks: readonly string[];
  requiredCapabilities: readonly HarnessRequiredCapability[];
  orchestration: HarnessOrchestrationConfig;
  execution: HarnessExecutionConfig;
  mcpConfigPath?: string;
}

export interface HarnessConfigInput {
  schemaVersion?: number;
  provider?: string;
  model?: string;
  workspace?: string;
  stateDirectory?: string;
  storeBackend?: string;
  tenantId?: string;
  userId?: string;
  namespace?: string;
  maxSteps?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxToolErrors?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  compactionMaxMessages?: number;
  compactionMaxEstimatedInputTokens?: number;
  compactionKeepRecentMessages?: number;
  allowedChecks?: readonly string[];
  requiredCapabilities?: readonly string[];
  subagentProfiles?: readonly string[];
  subagentMaxSteps?: number;
  subagentMaxToolCalls?: number;
  subagentMaxToolErrors?: number;
  subagentMaxInputTokens?: number;
  subagentMaxOutputTokens?: number;
  subagentMaxTotalTokens?: number;
  subagentTimeoutMs?: number;
  maxParallelReviews?: number;
  executionBackend?: string;
  ociRuntime?: string;
  ociImage?: string;
  ociAllowedCommands?: readonly string[];
  ociMaxProcessRuntimeMs?: number;
  ociMaxProcessOutputBytes?: number;
  ociMaxMemoryMb?: number;
  ociMaxPids?: number;
  ociMaxCpus?: number;
  ociMaxWorkspaceBytes?: number;
  ociMaxFileWriteBytes?: number;
  ociTmpfsMb?: number;
  mcpConfigPath?: string;
}

const integerOption = (
  name: string,
  input: number | undefined,
  envValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const value = input ?? (envValue === undefined ? fallback : Number(envValue));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
};

const scopeValue = (name: string, value: string | undefined, fallback?: string) => {
  const configured = value?.trim();
  const normalized = configured || fallback?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} must contain 1-128 printable characters.`);
  }
  return normalized;
};

const nonNegativeNumberOption = (
  name: string,
  input: number | undefined,
  envValue: string | undefined
) => {
  if (input === undefined && envValue === undefined) {
    return undefined;
  }
  const value = input ?? Number(envValue);
  if (!Number.isFinite(value) || value! < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value!;
};

export const defaultHarnessNamespace = (workspace: string) =>
  `workspace-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`;

const canonicalStateDirectory = (
  requestedWorkspace: string,
  canonicalWorkspace: string,
  configured: string | undefined
) => {
  if (!configured) {
    return path.join(canonicalWorkspace, ".zhivex-harness", "runs");
  }
  const requestedStateDirectory = path.resolve(configured);
  const relative = path.relative(requestedWorkspace, requestedStateDirectory);
  const insideRequestedWorkspace = relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
  return insideRequestedWorkspace
    ? path.resolve(canonicalWorkspace, relative)
    : requestedStateDirectory;
};

const resolveAllowedChecks = (configured: readonly string[] | undefined) => {
  const source = configured ?? (
    process.env.ZHIVEX_HARNESS_ALLOWED_CHECKS === undefined
      ? DEFAULT_ALLOWED_CHECKS
      : process.env.ZHIVEX_HARNESS_ALLOWED_CHECKS.split(",")
  );
  const checks = [...new Set(source.map((value) => value.trim()).filter(Boolean))];
  if (checks.length > 50) {
    throw new Error("allowedChecks cannot contain more than 50 script names.");
  }
  const invalid = checks.find((value) => !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(value));
  if (invalid) {
    throw new Error(
      `Invalid allowed check name: ${invalid}. Use 1-64 letters, digits, colon, underscore, or hyphen.`
    );
  }
  return checks;
};

const commaSeparatedValues = (
  configured: readonly string[] | undefined,
  envValue: string | undefined,
  fallback: readonly string[]
) => configured ?? (envValue === undefined ? fallback : envValue.split(","));

const resolveRequiredCapabilities = (configured: readonly string[] | undefined) => {
  const values = commaSeparatedValues(
    configured,
    process.env.ZHIVEX_HARNESS_REQUIRED_CAPABILITIES,
    ["streaming", "tools"]
  );
  const capabilities = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const invalid = capabilities.find((value) =>
    !(HARNESS_REQUIRED_CAPABILITIES as readonly string[]).includes(value)
  );
  if (invalid) {
    throw new Error(
      `Unknown required capability: ${invalid}. Use ${HARNESS_REQUIRED_CAPABILITIES.join(", ")}.`
    );
  }
  return capabilities as HarnessRequiredCapability[];
};

const resolveSubagentProfiles = (configured: readonly string[] | undefined) => {
  const values = commaSeparatedValues(
    configured,
    process.env.ZHIVEX_HARNESS_SUBAGENTS,
    HARNESS_SUBAGENT_PROFILES
  );
  const profiles = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const invalid = profiles.find((value) =>
    !(HARNESS_SUBAGENT_PROFILES as readonly string[]).includes(value)
  );
  if (invalid) {
    throw new Error(
      `Unknown subagent profile: ${invalid}. Use ${HARNESS_SUBAGENT_PROFILES.join(", ")}.`
    );
  }
  return profiles as HarnessSubagentProfile[];
};

const resolveOciAllowedCommands = (configured: readonly string[] | undefined) => {
  const values = commaSeparatedValues(
    configured,
    process.env.ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS,
    DEFAULT_OCI_EXECUTION.allowedCommands
  );
  const commands = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (commands.length === 0 || commands.length > 50) {
    throw new Error("ociAllowedCommands must contain between 1 and 50 executable names.");
  }
  const invalid = commands.find((value) => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value));
  if (invalid) {
    throw new Error(`Invalid OCI command name: ${invalid}. Use a bare executable name without a path.`);
  }
  if (!commands.includes("bun")) {
    throw new Error("ociAllowedCommands must include bun so declared package checks remain available.");
  }
  return commands;
};

const resolveExecutionConfig = (input: HarnessConfigInput): HarnessExecutionConfig => {
  const backend = (input.executionBackend ?? process.env.ZHIVEX_HARNESS_EXECUTION ?? "none")
    .trim()
    .toLowerCase();
  if (!(HARNESS_EXECUTION_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(`executionBackend must be one of: ${HARNESS_EXECUTION_BACKENDS.join(", ")}.`);
  }
  if (backend === "none") {
    return { backend: "none" };
  }
  const runtime = (input.ociRuntime ?? process.env.ZHIVEX_HARNESS_OCI_RUNTIME ?? DEFAULT_OCI_EXECUTION.runtime)
    .trim()
    .toLowerCase();
  if (!(HARNESS_OCI_RUNTIMES as readonly string[]).includes(runtime)) {
    throw new Error(`ociRuntime must be one of: ${HARNESS_OCI_RUNTIMES.join(", ")}.`);
  }
  const image = (input.ociImage ?? process.env.ZHIVEX_HARNESS_OCI_IMAGE ?? DEFAULT_OCI_EXECUTION.image).trim();
  if (!image || image.length > 512 || /[\u0000-\u001f\u007f\s]/.test(image) || image.startsWith("-")) {
    throw new Error("ociImage must be a non-empty OCI image reference without whitespace or control characters.");
  }
  const maxWorkspaceBytes = integerOption(
    "ociMaxWorkspaceBytes",
    input.ociMaxWorkspaceBytes,
    process.env.ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES,
    DEFAULT_OCI_EXECUTION.maxWorkspaceBytes,
    1024 * 1024,
    1024 * 1024 * 1024
  );
  const maxFileWriteBytes = integerOption(
    "ociMaxFileWriteBytes",
    input.ociMaxFileWriteBytes,
    process.env.ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES,
    DEFAULT_OCI_EXECUTION.maxFileWriteBytes,
    1024,
    16 * 1024 * 1024
  );
  if (maxFileWriteBytes > maxWorkspaceBytes) {
    throw new Error("ociMaxFileWriteBytes cannot exceed ociMaxWorkspaceBytes.");
  }
  return {
    backend: "oci",
    policyVersion: HARNESS_EXECUTION_POLICY_VERSION,
    runtime: runtime as HarnessOciRuntime,
    image,
    allowedCommands: resolveOciAllowedCommands(input.ociAllowedCommands),
    maxProcessRuntimeMs: integerOption("ociMaxProcessRuntimeMs", input.ociMaxProcessRuntimeMs, process.env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS, DEFAULT_OCI_EXECUTION.maxProcessRuntimeMs, 1_000, 60 * 60_000),
    maxProcessOutputBytes: integerOption("ociMaxProcessOutputBytes", input.ociMaxProcessOutputBytes, process.env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES, DEFAULT_OCI_EXECUTION.maxProcessOutputBytes, 1_024, 1024 * 1024),
    maxMemoryMb: integerOption("ociMaxMemoryMb", input.ociMaxMemoryMb, process.env.ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB, DEFAULT_OCI_EXECUTION.maxMemoryMb, 64, 64 * 1024),
    maxPids: integerOption("ociMaxPids", input.ociMaxPids, process.env.ZHIVEX_HARNESS_OCI_MAX_PIDS, DEFAULT_OCI_EXECUTION.maxPids, 16, 4_096),
    maxCpus: integerOption("ociMaxCpus", input.ociMaxCpus, process.env.ZHIVEX_HARNESS_OCI_MAX_CPUS, DEFAULT_OCI_EXECUTION.maxCpus, 1, 64),
    maxWorkspaceBytes,
    maxFileWriteBytes,
    tmpfsMb: integerOption("ociTmpfsMb", input.ociTmpfsMb, process.env.ZHIVEX_HARNESS_OCI_TMPFS_MB, DEFAULT_OCI_EXECUTION.tmpfsMb, 16, 4_096)
  };
};

const canonicalWorkspaceFile = (
  requestedWorkspace: string,
  canonicalWorkspace: string,
  configured: string | undefined
) => {
  if (!configured?.trim()) {
    return undefined;
  }
  const requestedPath = path.resolve(requestedWorkspace, configured.trim());
  const relative = path.relative(requestedWorkspace, requestedPath);
  const insideRequestedWorkspace = relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
  return insideRequestedWorkspace
    ? path.resolve(canonicalWorkspace, relative)
    : requestedPath;
};

export const parseProvider = (
  value: string | undefined,
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
): HarnessProvider => registry.parse(value);

export const providerDescriptor = (
  provider: HarnessProvider,
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
): ProviderDescriptor => registry.descriptor(provider);

export const resolveHarnessConfig = (
  input: HarnessConfigInput = {},
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
): HarnessConfig => {
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== HARNESS_CONFIG_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported config schema version: ${input.schemaVersion}. Expected ${HARNESS_CONFIG_SCHEMA_VERSION}.`
    );
  }
  const provider = parseProvider(input.provider ?? process.env.ZHIVEX_HARNESS_PROVIDER, registry);
  const descriptor = providerDescriptor(provider, registry);
  const requestedWorkspace = path.resolve(input.workspace ?? process.cwd());
  let workspace = requestedWorkspace;
  try {
    workspace = realpathSync(requestedWorkspace);
  } catch {
    // Workspace.open and doctor produce the actionable existence/type diagnostic.
  }
  const maxSteps = integerOption(
    "maxSteps",
    input.maxSteps,
    process.env.ZHIVEX_HARNESS_MAX_STEPS,
    12,
    1,
    50
  );
  const storeBackend = (input.storeBackend ?? process.env.ZHIVEX_HARNESS_STORE ?? "sqlite").trim().toLowerCase();
  if (!(HARNESS_STORE_BACKENDS as readonly string[]).includes(storeBackend)) {
    throw new Error(`storeBackend must be one of: ${HARNESS_STORE_BACKENDS.join(", ")}.`);
  }
  const tenantId = scopeValue(
    "tenantId",
    input.tenantId ?? process.env.ZHIVEX_HARNESS_TENANT_ID,
    "local"
  )!;
  const userId = scopeValue("userId", input.userId ?? process.env.ZHIVEX_HARNESS_USER_ID);
  const namespace = scopeValue(
    "namespace",
    input.namespace ?? process.env.ZHIVEX_HARNESS_NAMESPACE,
    defaultHarnessNamespace(workspace)
  );
  const timeoutMs = integerOption(
    "timeoutMs",
    input.timeoutMs,
    process.env.ZHIVEX_HARNESS_TIMEOUT_MS,
    15 * 60_000,
    1_000,
    24 * 60 * 60_000
  );
  const budget: HarnessBudget = {
    maxSteps,
    maxToolCalls: integerOption("maxToolCalls", input.maxToolCalls, process.env.ZHIVEX_HARNESS_MAX_TOOL_CALLS, DEFAULT_HARNESS_BUDGET.maxToolCalls, 0, 500),
    maxToolErrors: integerOption("maxToolErrors", input.maxToolErrors, process.env.ZHIVEX_HARNESS_MAX_TOOL_ERRORS, DEFAULT_HARNESS_BUDGET.maxToolErrors, 0, 100),
    maxInputTokens: integerOption("maxInputTokens", input.maxInputTokens, process.env.ZHIVEX_HARNESS_MAX_INPUT_TOKENS, DEFAULT_HARNESS_BUDGET.maxInputTokens, 1, 10_000_000),
    maxOutputTokens: integerOption("maxOutputTokens", input.maxOutputTokens, process.env.ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS, DEFAULT_HARNESS_BUDGET.maxOutputTokens, 1, 10_000_000),
    maxTotalTokens: integerOption("maxTotalTokens", input.maxTotalTokens, process.env.ZHIVEX_HARNESS_MAX_TOTAL_TOKENS, DEFAULT_HARNESS_BUDGET.maxTotalTokens, 1, 20_000_000),
    includeChildRuns: true
  };
  if (budget.maxTotalTokens < budget.maxInputTokens || budget.maxTotalTokens < budget.maxOutputTokens) {
    throw new Error("maxTotalTokens must be greater than or equal to the input and output token limits.");
  }
  const maxCostUsd = nonNegativeNumberOption(
    "maxCostUsd",
    input.maxCostUsd,
    process.env.ZHIVEX_HARNESS_MAX_COST_USD
  );
  const inputCostPerMillion = nonNegativeNumberOption(
    "inputCostPerMillion",
    input.inputCostPerMillion,
    process.env.ZHIVEX_HARNESS_INPUT_COST_PER_MILLION
  );
  const outputCostPerMillion = nonNegativeNumberOption(
    "outputCostPerMillion",
    input.outputCostPerMillion,
    process.env.ZHIVEX_HARNESS_OUTPUT_COST_PER_MILLION
  );
  if (maxCostUsd !== undefined && inputCostPerMillion === undefined && outputCostPerMillion === undefined) {
    throw new Error("maxCostUsd requires inputCostPerMillion or outputCostPerMillion pricing.");
  }
  if (maxCostUsd === undefined && (inputCostPerMillion !== undefined || outputCostPerMillion !== undefined)) {
    throw new Error("Token pricing requires maxCostUsd.");
  }
  const compaction: HarnessCompactionConfig = {
    maxMessages: integerOption("compactionMaxMessages", input.compactionMaxMessages, process.env.ZHIVEX_HARNESS_COMPACTION_MAX_MESSAGES, DEFAULT_HARNESS_COMPACTION.maxMessages, 4, 10_000),
    maxEstimatedInputTokens: integerOption("compactionMaxEstimatedInputTokens", input.compactionMaxEstimatedInputTokens, process.env.ZHIVEX_HARNESS_COMPACTION_MAX_INPUT_TOKENS, DEFAULT_HARNESS_COMPACTION.maxEstimatedInputTokens, 1_000, 10_000_000),
    keepRecentMessages: integerOption("compactionKeepRecentMessages", input.compactionKeepRecentMessages, process.env.ZHIVEX_HARNESS_COMPACTION_KEEP_RECENT, DEFAULT_HARNESS_COMPACTION.keepRecentMessages, 2, 1_000)
  };
  if (compaction.keepRecentMessages >= compaction.maxMessages) {
    throw new Error("compactionKeepRecentMessages must be smaller than compactionMaxMessages.");
  }
  const childBudget: HarnessBudget = {
    maxSteps: integerOption("subagentMaxSteps", input.subagentMaxSteps, process.env.ZHIVEX_HARNESS_SUBAGENT_MAX_STEPS, DEFAULT_SUBAGENT_BUDGET.maxSteps, 1, 30),
    maxToolCalls: integerOption("subagentMaxToolCalls", input.subagentMaxToolCalls, process.env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_CALLS, DEFAULT_SUBAGENT_BUDGET.maxToolCalls, 0, 200),
    maxToolErrors: integerOption("subagentMaxToolErrors", input.subagentMaxToolErrors, process.env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_ERRORS, DEFAULT_SUBAGENT_BUDGET.maxToolErrors, 0, 50),
    maxInputTokens: integerOption("subagentMaxInputTokens", input.subagentMaxInputTokens, process.env.ZHIVEX_HARNESS_SUBAGENT_MAX_INPUT_TOKENS, DEFAULT_SUBAGENT_BUDGET.maxInputTokens, 1, 2_000_000),
    maxOutputTokens: integerOption("subagentMaxOutputTokens", input.subagentMaxOutputTokens, process.env.ZHIVEX_HARNESS_SUBAGENT_MAX_OUTPUT_TOKENS, DEFAULT_SUBAGENT_BUDGET.maxOutputTokens, 1, 2_000_000),
    maxTotalTokens: integerOption("subagentMaxTotalTokens", input.subagentMaxTotalTokens, process.env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOTAL_TOKENS, DEFAULT_SUBAGENT_BUDGET.maxTotalTokens, 1, 4_000_000),
    includeChildRuns: false
  };
  if (childBudget.maxTotalTokens < childBudget.maxInputTokens || childBudget.maxTotalTokens < childBudget.maxOutputTokens) {
    throw new Error("subagentMaxTotalTokens must be greater than or equal to the child input and output token limits.");
  }
  const orchestration: HarnessOrchestrationConfig = {
    profiles: resolveSubagentProfiles(input.subagentProfiles),
    childBudget,
    childTimeoutMs: integerOption(
      "subagentTimeoutMs",
      input.subagentTimeoutMs,
      process.env.ZHIVEX_HARNESS_SUBAGENT_TIMEOUT_MS,
      Math.min(timeoutMs, 5 * 60_000),
      1_000,
      24 * 60 * 60_000
    ),
    maxParallelReviews: integerOption(
      "maxParallelReviews",
      input.maxParallelReviews,
      process.env.ZHIVEX_HARNESS_MAX_PARALLEL_REVIEWS,
      2,
      1,
      4
    )
  };
  const mcpConfigPath = canonicalWorkspaceFile(
    requestedWorkspace,
    workspace,
    input.mcpConfigPath ?? process.env.ZHIVEX_HARNESS_MCP_CONFIG
  );
  const execution = resolveExecutionConfig(input);

  return {
    schemaVersion: HARNESS_CONFIG_SCHEMA_VERSION,
    provider,
    model: input.model ?? process.env.ZHIVEX_HARNESS_MODEL ?? descriptor.defaultModel,
    workspace,
    stateDirectory: canonicalStateDirectory(requestedWorkspace, workspace, input.stateDirectory),
    storeBackend: storeBackend as HarnessStoreBackend,
    scope: {
      tenantId,
      ...(userId ? { userId } : {}),
      ...(namespace ? { namespace } : {})
    },
    maxSteps,
    timeoutMs,
    budget,
    ...(maxCostUsd === undefined
      ? {}
      : {
          costBudget: {
            maxCostUsd,
            inputCostPer1kTokens: (inputCostPerMillion ?? 0) / 1_000,
            outputCostPer1kTokens: (outputCostPerMillion ?? 0) / 1_000
          }
        }),
    compaction,
    allowedChecks: resolveAllowedChecks(input.allowedChecks),
    requiredCapabilities: resolveRequiredCapabilities(input.requiredCapabilities),
    orchestration,
    execution,
    ...(mcpConfigPath ? { mcpConfigPath } : {})
  };
};

export const createProviderModel = (
  config: Pick<HarnessConfig, "provider" | "model">,
  env: NodeJS.ProcessEnv = process.env,
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
): LanguageModel => registry.createModel(config, env);

export const providerAvailability = (
  env: NodeJS.ProcessEnv = process.env,
  registry: HarnessProviderRegistry = DEFAULT_PROVIDER_REGISTRY
): readonly ProviderAvailability[] => registry.availability(env);

export {
  BUILTIN_PROVIDER_REGISTRATIONS,
  DEFAULT_PROVIDER_REGISTRY,
  PROVIDERS,
  PROVIDER_DESCRIPTORS,
  createProviderRegistry
};

export type {
  BuiltInHarnessProvider,
  HarnessProvider,
  HarnessProviderRegistry,
  ProviderAvailability,
  ProviderCapability,
  ProviderCredentials,
  ProviderDescriptor,
  ProviderDiagnosticsDescriptor,
  ProviderEnumDiagnostic,
  ProviderModelFactory,
  ProviderModelFactoryContext,
  ProviderPresenceDiagnostic,
  ProviderRegistration,
  ProviderSupport
};
