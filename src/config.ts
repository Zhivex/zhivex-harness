import path from "node:path";

import { createMeta } from "@zhivex-ai/meta";
import { createOpenAI } from "@zhivex-ai/openai";
import { createQwen, type QwenRegion } from "@zhivex-ai/qwen";
import type { LanguageModel } from "@zhivex-ai/agents";

export const PROVIDERS = ["meta", "qwen", "openai"] as const;

export type HarnessProvider = (typeof PROVIDERS)[number];

export interface ProviderDescriptor {
  id: HarnessProvider;
  name: string;
  defaultModel: string;
  credentialNames: readonly string[];
}

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: "meta",
    name: "Meta Model API",
    defaultModel: "muse-spark-1.2",
    credentialNames: ["MODEL_API_KEY"]
  },
  {
    id: "qwen",
    name: "Qwen / Alibaba Cloud Model Studio",
    defaultModel: "qwen3.8-max",
    credentialNames: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-5.4",
    credentialNames: ["OPENAI_API_KEY"]
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
  provider: HarnessProvider;
  model: string;
  workspace: string;
  stateDirectory: string;
  maxSteps: number;
}

export interface HarnessConfigInput {
  provider?: string;
  model?: string;
  workspace?: string;
  stateDirectory?: string;
  maxSteps?: number;
}

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
  const provider = parseProvider(input.provider ?? process.env.ZHIVEX_HARNESS_PROVIDER);
  const descriptor = providerDescriptor(provider);
  const workspace = path.resolve(input.workspace ?? process.cwd());
  const maxSteps = input.maxSteps ?? Number(process.env.ZHIVEX_HARNESS_MAX_STEPS ?? 12);

  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) {
    throw new Error("maxSteps must be an integer between 1 and 50.");
  }

  return {
    provider,
    model: input.model ?? process.env.ZHIVEX_HARNESS_MODEL ?? descriptor.defaultModel,
    workspace,
    stateDirectory: path.resolve(
      input.stateDirectory ?? path.join(workspace, ".zhivex-harness", "runs")
    ),
    maxSteps
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

export const providerAvailability = (env: NodeJS.ProcessEnv = process.env) =>
  PROVIDER_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    configured: descriptor.credentialNames.some((name) => Boolean(env[name]?.trim()))
  }));
