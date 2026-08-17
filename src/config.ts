import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { createMeta } from "@zhivex-ai/meta";
import { createOpenAI } from "@zhivex-ai/openai";
import { createQwen, type QwenRegion } from "@zhivex-ai/qwen";
import type { LanguageModel } from "@zhivex-ai/agents";
import type { AgentStoreScope } from "@zhivex-ai/agents/ops";

export const PROVIDERS = ["meta", "qwen", "openai"] as const;

export const DEFAULT_ALLOWED_CHECKS = ["test", "typecheck", "lint", "build"] as const;

export const HARNESS_CONFIG_SCHEMA_VERSION = 2 as const;

export const HARNESS_STORE_BACKENDS = ["sqlite", "file"] as const;

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

export type HarnessStoreBackend = (typeof HARNESS_STORE_BACKENDS)[number];

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

export type HarnessProvider = (typeof PROVIDERS)[number];

export interface ProviderDescriptor {
  id: HarnessProvider;
  name: string;
  defaultModel: string;
  credentialNames: readonly string[];
  capabilities: readonly ProviderCapability[];
  support: ProviderSupport;
}

export type ProviderCapability = "streaming" | "tool-calling" | "approval-resume";
export type ProviderSupport = "certified" | "provisional";

const HARNESS_PROVIDER_CAPABILITIES = [
  "streaming",
  "tool-calling",
  "approval-resume"
] as const satisfies readonly ProviderCapability[];

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: "meta",
    name: "Meta Model API",
    defaultModel: "muse-spark-1.2",
    credentialNames: ["MODEL_API_KEY"],
    capabilities: HARNESS_PROVIDER_CAPABILITIES,
    support: "certified"
  },
  {
    id: "qwen",
    name: "Qwen / Alibaba Cloud Model Studio",
    defaultModel: "qwen3.8-max",
    credentialNames: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    capabilities: HARNESS_PROVIDER_CAPABILITIES,
    support: "certified"
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-5.4",
    credentialNames: ["OPENAI_API_KEY"],
    capabilities: HARNESS_PROVIDER_CAPABILITIES,
    support: "certified"
  }
] as const;

const QWEN_REGIONS = [
  "singapore",
  "beijing",
  "hong-kong",
  "tokyo",
  "frankfurt",
  "virginia"
] as const satisfies readonly QwenRegion[];

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

export const parseProvider = (value: string | undefined): HarnessProvider => {
  const normalized = (value ?? "openai").trim().toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(normalized)) {
    return normalized as HarnessProvider;
  }
  throw new Error(`Unknown provider: ${value}. Use meta, qwen, or openai.`);
};

export const providerDescriptor = (provider: HarnessProvider): ProviderDescriptor => {
  const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.id === provider);
  if (!descriptor) {
    throw new Error(`No descriptor is available for provider ${provider}.`);
  }
  return descriptor;
};

export const resolveHarnessConfig = (input: HarnessConfigInput = {}): HarnessConfig => {
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== HARNESS_CONFIG_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported config schema version: ${input.schemaVersion}. Expected ${HARNESS_CONFIG_SCHEMA_VERSION}.`
    );
  }
  const provider = parseProvider(input.provider ?? process.env.ZHIVEX_HARNESS_PROVIDER);
  const descriptor = providerDescriptor(provider);
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
    allowedChecks: resolveAllowedChecks(input.allowedChecks)
  };
};

const requiredCredential = (
  env: NodeJS.ProcessEnv,
  provider: HarnessProvider,
  names: readonly string[]
): string => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(
    `Missing credentials for ${provider}. Set ${names.join(" or ")} in the environment.`
  );
};

const optionalQwenRegion = (value: string | undefined): QwenRegion | undefined => {
  if (!value) {
    return undefined;
  }
  if ((QWEN_REGIONS as readonly string[]).includes(value)) {
    return value as QwenRegion;
  }
  throw new Error(`Invalid QWEN_REGION: ${value}.`);
};

export const createProviderModel = (
  config: Pick<HarnessConfig, "provider" | "model">,
  env: NodeJS.ProcessEnv = process.env
): LanguageModel => {
  switch (config.provider) {
    case "meta": {
      const baseURL = env.META_BASE_URL?.trim();
      const provider = createMeta({
        apiKey: requiredCredential(env, "meta", ["MODEL_API_KEY"]),
        ...(baseURL ? { baseURL } : {})
      });
      return provider(config.model);
    }
    case "qwen": {
      const baseURL = env.QWEN_BASE_URL?.trim();
      const workspaceId = env.QWEN_WORKSPACE_ID?.trim();
      const region = optionalQwenRegion(env.QWEN_REGION?.trim());
      const provider = createQwen({
        apiKey: requiredCredential(env, "qwen", ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]),
        ...(baseURL ? { baseURL } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(region ? { region } : {})
      });
      return provider(config.model);
    }
    case "openai": {
      const baseURL = env.OPENAI_BASE_URL?.trim();
      const provider = createOpenAI({
        apiKey: requiredCredential(env, "openai", ["OPENAI_API_KEY"]),
        ...(baseURL ? { baseURL } : {})
      });
      return provider(config.model);
    }
  }
};

const endpointConfiguration = (value: string | undefined) => {
  const configured = Boolean(value?.trim());
  if (!configured) {
    return {
      customEndpoint: false,
      endpointValid: true,
      endpointSecure: true
    };
  }
  try {
    const endpoint = new URL(value!.trim());
    const supportedProtocol = endpoint.protocol === "https:" || endpoint.protocol === "http:";
    return {
      customEndpoint: true,
      endpointValid: supportedProtocol && !endpoint.username && !endpoint.password && !endpoint.hash,
      endpointSecure: endpoint.protocol === "https:"
    };
  } catch {
    return {
      customEndpoint: true,
      endpointValid: false,
      endpointSecure: false
    };
  }
};

export const providerAvailability = (env: NodeJS.ProcessEnv = process.env) =>
  PROVIDER_DESCRIPTORS.map((descriptor) => {
    const credentials = descriptor.credentialNames.map((name) => ({
      name,
      present: Boolean(env[name]?.trim())
    }));
    const endpointVariable = descriptor.id === "meta"
      ? "META_BASE_URL"
      : descriptor.id === "qwen"
        ? "QWEN_BASE_URL"
        : "OPENAI_BASE_URL";
    const regionValue = descriptor.id === "qwen" ? env.QWEN_REGION?.trim() : undefined;

    return {
      ...descriptor,
      configured: credentials.some((credential) => credential.present),
      credentials,
      configuration: {
        ...endpointConfiguration(env[endpointVariable]),
        ...(descriptor.id === "qwen"
          ? {
              workspaceIdConfigured: Boolean(env.QWEN_WORKSPACE_ID?.trim()),
              regionConfigured: Boolean(regionValue),
              regionValid: !regionValue || (QWEN_REGIONS as readonly string[]).includes(regionValue)
            }
          : {})
      }
    };
  });
