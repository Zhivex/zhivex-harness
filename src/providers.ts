import { createHash } from "node:crypto";

import type { LanguageModel } from "@zhivex-ai/agents";
import {
  wrapLanguageModel,
  type GenerateResult,
  type ModelGenerateInput,
  type ModelMessage,
  type StreamEvent,
  type ToolCall
} from "@zhivex-ai/core";
import { createGemini } from "@zhivex-ai/gemini";
import { createMeta } from "@zhivex-ai/meta";
import { createOpenAI } from "@zhivex-ai/openai";
import { createQwen, type QwenRegion } from "@zhivex-ai/qwen";

export const PROVIDERS = ["meta", "qwen", "openai", "gemini"] as const;

export type BuiltInHarnessProvider = (typeof PROVIDERS)[number];
export type HarnessProvider = BuiltInHarnessProvider | (string & {});
export type ProviderCapability = "streaming" | "tool-calling" | "approval-resume";
export type ProviderSupport = "certified" | "provisional";

export interface ProviderDescriptor {
  readonly id: HarnessProvider;
  readonly name: string;
  readonly defaultModel: string;
  readonly credentialNames: readonly string[];
  readonly capabilities: readonly ProviderCapability[];
  readonly support: ProviderSupport;
}

export interface ProviderCredentials {
  readonly names: readonly string[];
  get(name: string): string | undefined;
  first(): string | undefined;
  require(): string;
}

export interface ProviderModelFactoryContext {
  readonly provider: HarnessProvider;
  readonly model: string;
  readonly env: NodeJS.ProcessEnv;
  readonly credentials: ProviderCredentials;
}

export type ProviderModelFactory = (context: ProviderModelFactoryContext) => LanguageModel;

export interface ProviderPresenceDiagnostic {
  /** Output is exposed as `<key>Configured`; the environment value is never returned. */
  readonly key: string;
  readonly environmentVariable: string;
}

export interface ProviderEnumDiagnostic extends ProviderPresenceDiagnostic {
  /** Output also includes `<key>Valid`, based only on membership in this allowlist. */
  readonly allowedValues: readonly string[];
}

export interface ProviderDiagnosticsDescriptor {
  /** Produces only customEndpoint, endpointValid, and endpointSecure booleans. */
  readonly endpointEnvironmentVariable?: string;
  readonly presence?: readonly ProviderPresenceDiagnostic[];
  readonly enums?: readonly ProviderEnumDiagnostic[];
}

export interface ProviderRegistration {
  readonly descriptor: ProviderDescriptor;
  readonly factory: ProviderModelFactory;
  readonly diagnostics?: ProviderDiagnosticsDescriptor;
}

export interface ProviderAvailability extends ProviderDescriptor {
  readonly configured: boolean;
  readonly credentials: readonly { readonly name: string; readonly present: boolean }[];
  readonly configuration: Readonly<Record<string, boolean>> & {
    readonly customEndpoint: boolean;
    readonly endpointValid: boolean;
    readonly endpointSecure: boolean;
  };
}

export interface HarnessProviderRegistry {
  readonly descriptors: readonly ProviderDescriptor[];
  has(provider: string): boolean;
  parse(value?: string): HarnessProvider;
  descriptor(provider: HarnessProvider): ProviderDescriptor;
  createModel(
    config: Readonly<{ provider: HarnessProvider; model: string }>,
    env?: NodeJS.ProcessEnv
  ): LanguageModel;
  availability(env?: NodeJS.ProcessEnv): readonly ProviderAvailability[];
  /** Stable hash of non-credential transport settings used by durable resume bindings. */
  transportFingerprint(env?: NodeJS.ProcessEnv): string;
  extend(registrations: readonly ProviderRegistration[]): HarnessProviderRegistry;
}

const HARNESS_PROVIDER_CAPABILITIES = [
  "streaming",
  "tool-calling",
  "approval-resume"
] as const satisfies readonly ProviderCapability[];

const QWEN_REGIONS = [
  "singapore",
  "beijing",
  "hong-kong",
  "tokyo",
  "frankfurt",
  "virginia"
] as const satisfies readonly QwenRegion[];

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const DIAGNOSTIC_KEY = /^[a-z][A-Za-z0-9]{0,63}$/;

const requiredText = (name: string, value: string) => {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} must be a non-empty printable string.`);
  }
  return normalized;
};

const environmentVariable = (name: string, value: string) => {
  if (!ENVIRONMENT_VARIABLE.test(value)) {
    throw new Error(`${name} must be a valid environment variable name.`);
  }
  return value;
};

const diagnosticKey = (value: string) => {
  if (!DIAGNOSTIC_KEY.test(value)) {
    throw new Error(`Invalid provider diagnostic key: ${value}.`);
  }
  return value;
};

const normalizedDescriptor = (descriptor: ProviderDescriptor): ProviderDescriptor => {
  const id = descriptor.id.trim().toLowerCase();
  if (descriptor.id !== id || !PROVIDER_ID.test(id)) {
    throw new Error(
      `Invalid provider id: ${descriptor.id}. Use 1-64 lowercase letters, digits, dot, underscore, or hyphen.`
    );
  }
  if (!(descriptor.support === "certified" || descriptor.support === "provisional")) {
    throw new Error(`Invalid support level for provider ${id}.`);
  }
  const credentialNames = [...new Set(descriptor.credentialNames.map((name) =>
    environmentVariable(`Credential for provider ${id}`, name)
  ))];
  const capabilities = [...new Set(descriptor.capabilities)];
  const invalidCapability = capabilities.find((capability) =>
    !(HARNESS_PROVIDER_CAPABILITIES as readonly string[]).includes(capability)
  );
  if (invalidCapability) {
    throw new Error(`Invalid capability for provider ${id}: ${invalidCapability}.`);
  }
  return Object.freeze({
    id,
    name: requiredText(`Name for provider ${id}`, descriptor.name),
    defaultModel: requiredText(`Default model for provider ${id}`, descriptor.defaultModel),
    credentialNames: Object.freeze(credentialNames),
    capabilities: Object.freeze(capabilities),
    support: descriptor.support
  });
};

const normalizedDiagnostics = (
  provider: HarnessProvider,
  diagnostics: ProviderDiagnosticsDescriptor | undefined
): ProviderDiagnosticsDescriptor => {
  const endpointEnvironmentVariable = diagnostics?.endpointEnvironmentVariable === undefined
    ? undefined
    : environmentVariable(
        `Endpoint diagnostic for provider ${provider}`,
        diagnostics.endpointEnvironmentVariable
      );
  const seenKeys = new Set<string>();
  const presence = (diagnostics?.presence ?? []).map((entry) => {
    const key = diagnosticKey(entry.key);
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate diagnostic key for provider ${provider}: ${key}.`);
    }
    seenKeys.add(key);
    return Object.freeze({
      key,
      environmentVariable: environmentVariable(
        `Presence diagnostic for provider ${provider}`,
        entry.environmentVariable
      )
    });
  });
  const enums = (diagnostics?.enums ?? []).map((entry) => {
    const key = diagnosticKey(entry.key);
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate diagnostic key for provider ${provider}: ${key}.`);
    }
    seenKeys.add(key);
    const allowedValues = [...new Set(entry.allowedValues.map((value) => requiredText(
      `Allowed diagnostic value for provider ${provider}`,
      value
    )))];
    if (allowedValues.length === 0) {
      throw new Error(`Enum diagnostic ${key} for provider ${provider} needs allowed values.`);
    }
    return Object.freeze({
      key,
      environmentVariable: environmentVariable(
        `Enum diagnostic for provider ${provider}`,
        entry.environmentVariable
      ),
      allowedValues: Object.freeze(allowedValues)
    });
  });
  return Object.freeze({
    ...(endpointEnvironmentVariable ? { endpointEnvironmentVariable } : {}),
    ...(presence.length > 0 ? { presence: Object.freeze(presence) } : {}),
    ...(enums.length > 0 ? { enums: Object.freeze(enums) } : {})
  });
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
      endpointValid: supportedProtocol &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.hash &&
        !endpoint.search,
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

const createCredentials = (
  env: NodeJS.ProcessEnv,
  provider: HarnessProvider,
  names: readonly string[]
): ProviderCredentials => Object.freeze({
  names,
  get: (name: string) => {
    if (!names.includes(name)) {
      throw new Error(`Credential ${name} is not declared for provider ${provider}.`);
    }
    return env[name]?.trim() || undefined;
  },
  first: () => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  },
  require: () => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) {
        return value;
      }
    }
    throw new Error(
      names.length === 0
        ? `Provider ${provider} does not declare a credential.`
        : `Missing credentials for ${provider}. Set ${names.join(" or ")} in the environment.`
    );
  }
});

interface NormalizedProviderRegistration {
  descriptor: ProviderDescriptor;
  factory: ProviderModelFactory;
  diagnostics: ProviderDiagnosticsDescriptor;
}

const normalizeRegistration = (registration: ProviderRegistration): NormalizedProviderRegistration => {
  if (typeof registration.factory !== "function") {
    throw new Error("Provider registration factory must be a function.");
  }
  const descriptor = normalizedDescriptor(registration.descriptor);
  return Object.freeze({
    descriptor,
    factory: registration.factory,
    diagnostics: normalizedDiagnostics(descriptor.id, registration.diagnostics)
  });
};

const providerConfiguration = (
  diagnostics: ProviderDiagnosticsDescriptor,
  env: NodeJS.ProcessEnv
) => {
  const configuration: Record<string, boolean> = endpointConfiguration(
    diagnostics.endpointEnvironmentVariable
      ? env[diagnostics.endpointEnvironmentVariable]
      : undefined
  );
  for (const entry of diagnostics.presence ?? []) {
    configuration[`${entry.key}Configured`] = Boolean(env[entry.environmentVariable]?.trim());
  }
  for (const entry of diagnostics.enums ?? []) {
    const value = env[entry.environmentVariable]?.trim();
    configuration[`${entry.key}Configured`] = Boolean(value);
    configuration[`${entry.key}Valid`] = !value || entry.allowedValues.includes(value);
  }
  return Object.freeze(configuration) as ProviderAvailability["configuration"];
};

const parseWithRegistrations = (
  value: string | undefined,
  registrations: ReadonlyMap<string, NormalizedProviderRegistration>
) => {
  const defaultProvider = registrations.has("openai")
    ? "openai"
    : registrations.keys().next().value;
  const normalized = (value ?? defaultProvider ?? "").trim().toLowerCase();
  if (registrations.has(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unknown provider: ${value}. Use ${[...registrations.keys()].join(", ")}.`
  );
};

export const createProviderRegistry = (
  registrations: readonly ProviderRegistration[]
): HarnessProviderRegistry => {
  if (registrations.length === 0) {
    throw new Error("Provider registry must contain at least one provider.");
  }
  const entries = new Map<string, NormalizedProviderRegistration>();
  for (const registration of registrations) {
    const normalized = normalizeRegistration(registration);
    if (entries.has(normalized.descriptor.id)) {
      throw new Error(`Duplicate provider registration: ${normalized.descriptor.id}.`);
    }
    entries.set(normalized.descriptor.id, normalized);
  }
  const frozenRegistrations = Object.freeze([...entries.values()]);
  const descriptors = Object.freeze(frozenRegistrations.map((entry) => entry.descriptor));

  const registry: HarnessProviderRegistry = Object.freeze({
    descriptors,
    has: (provider: string) => entries.has(provider.trim().toLowerCase()),
    parse: (value?: string) => parseWithRegistrations(value, entries),
    descriptor: (provider: HarnessProvider) => {
      const registration = entries.get(provider);
      if (!registration) {
        throw new Error(`No descriptor is available for provider ${provider}.`);
      }
      return registration.descriptor;
    },
    createModel: (
      config: Readonly<{ provider: HarnessProvider; model: string }>,
      env: NodeJS.ProcessEnv = process.env
    ) => {
      const registration = entries.get(config.provider);
      if (!registration) {
        throw new Error(`No factory is available for provider ${config.provider}.`);
      }
      return registration.factory(Object.freeze({
        provider: config.provider,
        model: config.model,
        env,
        credentials: createCredentials(env, config.provider, registration.descriptor.credentialNames)
      }));
    },
    availability: (env: NodeJS.ProcessEnv = process.env) => Object.freeze(
      frozenRegistrations.map((registration) => {
        const credentials = Object.freeze(registration.descriptor.credentialNames.map((name) =>
          Object.freeze({ name, present: Boolean(env[name]?.trim()) })
        ));
        return Object.freeze({
          ...registration.descriptor,
          configured: credentials.length === 0 || credentials.some((credential) => credential.present),
          credentials,
          configuration: providerConfiguration(registration.diagnostics, env)
        });
      })
    ),
    transportFingerprint: (env: NodeJS.ProcessEnv = process.env) => {
      const transport = frozenRegistrations.map((registration) => {
        const names = [
          registration.diagnostics.endpointEnvironmentVariable,
          ...(registration.diagnostics.presence ?? []).map((entry) => entry.environmentVariable),
          ...(registration.diagnostics.enums ?? []).map((entry) => entry.environmentVariable)
        ].filter((name): name is string => Boolean(name));
        return {
          provider: registration.descriptor.id,
          values: names.map((name) => [name, env[name]?.trim() ?? ""])
        };
      });
      return `sha256:${createHash("sha256").update(JSON.stringify(transport)).digest("hex")}`;
    },
    extend: (additional: readonly ProviderRegistration[]) => createProviderRegistry([
      ...frozenRegistrations,
      ...additional
    ])
  });
  return registry;
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

const generatedToolCallId = (
  model: Pick<LanguageModel, "provider" | "modelId">,
  input: ModelGenerateInput,
  index: number,
  toolCall: Pick<ToolCall, "name" | "input">
) => `harness_call_${createHash("sha256")
  .update(JSON.stringify({
    provider: model.provider,
    modelId: model.modelId,
    messages: input.messages,
    index,
    name: toolCall.name,
    input: toolCall.input
  }))
  .digest("hex")
  .slice(0, 48)}`;

const existingToolCallIds = (messages: readonly ModelMessage[]) => new Set(messages.flatMap((message) =>
  message.parts.flatMap((part) => {
    if (part.type === "tool-call") return [part.toolCall.id];
    if (part.type === "tool-result") return [part.toolResult.toolCallId];
    return [];
  }).filter((id) => typeof id === "string" && id.length > 0)
));

const normalizedToolCall = (
  model: Pick<LanguageModel, "provider" | "modelId">,
  input: ModelGenerateInput,
  index: number,
  toolCall: ToolCall,
  seenIds: Set<string>
): ToolCall => {
  const id = typeof toolCall.id === "string" && toolCall.id.trim().length > 0
    ? toolCall.id
    : generatedToolCallId(model, input, index, toolCall);
  if (seenIds.has(id)) {
    throw new Error(`Qwen returned a duplicate tool-call id: ${id}.`);
  }
  seenIds.add(id);
  return id === toolCall.id ? toolCall : { ...toolCall, id };
};

const normalizeMessageToolCallIds = (
  model: Pick<LanguageModel, "provider" | "modelId">,
  input: ModelGenerateInput,
  messages: readonly ModelMessage[],
  seenIds = existingToolCallIds(input.messages)
): ModelMessage[] => {
  let index = 0;
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => part.type === "tool-call"
      ? {
          ...part,
          toolCall: normalizedToolCall(model, input, index++, part.toolCall, seenIds)
        }
      : part)
  }));
};

const normalizeGenerateToolCallIds = (
  model: Pick<LanguageModel, "provider" | "modelId">,
  input: ModelGenerateInput,
  result: GenerateResult
): GenerateResult => {
  const messages = result.messages
    ? normalizeMessageToolCallIds(model, input, result.messages)
    : undefined;
  const message = result.message
    ? normalizeMessageToolCallIds(model, input, [result.message])[0]
    : undefined;
  return {
    ...result,
    ...(message ? { message } : {}),
    ...(messages ? { messages } : {})
  };
};

const normalizeStreamToolCallIds = async function* (
  model: Pick<LanguageModel, "provider" | "modelId">,
  input: ModelGenerateInput,
  events: AsyncIterable<StreamEvent>
): AsyncIterable<StreamEvent> {
  let index = 0;
  const seenIds = existingToolCallIds(input.messages);
  for await (const event of events) {
    if (event.type !== "tool-call") {
      yield event;
      continue;
    }
    yield {
      ...event,
      toolCall: normalizedToolCall(model, input, index++, event.toolCall, seenIds)
    };
  }
};

const withQwenDurableToolCallIds = (model: LanguageModel): LanguageModel => wrapLanguageModel(model, [{
  name: "harness-qwen-durable-tool-call-ids",
  wrapGenerate: async ({ input }, next) => normalizeGenerateToolCallIds(model, input, await next()),
  wrapStream: async ({ input }, next) => normalizeStreamToolCallIds(model, input, await next())
}]);

export const BUILTIN_PROVIDER_REGISTRATIONS: readonly ProviderRegistration[] = Object.freeze([
  {
    descriptor: {
      id: "meta",
      name: "Meta Model API",
      defaultModel: "muse-spark-1.2",
      credentialNames: ["MODEL_API_KEY"],
      capabilities: HARNESS_PROVIDER_CAPABILITIES,
      support: "certified"
    },
    diagnostics: { endpointEnvironmentVariable: "META_BASE_URL" },
    factory: ({ model, env, credentials }) => {
      const baseURL = env.META_BASE_URL?.trim();
      return createMeta({
        apiKey: credentials.require(),
        ...(baseURL ? { baseURL } : {})
      })(model);
    }
  },
  {
    descriptor: {
      id: "qwen",
      name: "Qwen / Alibaba Cloud Model Studio",
      defaultModel: "qwen3.8-max",
      credentialNames: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
      capabilities: HARNESS_PROVIDER_CAPABILITIES,
      support: "certified"
    },
    diagnostics: {
      endpointEnvironmentVariable: "QWEN_BASE_URL",
      presence: [{ key: "workspaceId", environmentVariable: "QWEN_WORKSPACE_ID" }],
      enums: [{
        key: "region",
        environmentVariable: "QWEN_REGION",
        allowedValues: QWEN_REGIONS
      }]
    },
    factory: ({ model, env, credentials }) => {
      const baseURL = env.QWEN_BASE_URL?.trim();
      const workspaceId = env.QWEN_WORKSPACE_ID?.trim();
      const region = optionalQwenRegion(env.QWEN_REGION?.trim());
      return withQwenDurableToolCallIds(createQwen({
        apiKey: credentials.require(),
        ...(baseURL ? { baseURL } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(region ? { region } : {})
      })(model));
    }
  },
  {
    descriptor: {
      id: "openai",
      name: "OpenAI",
      defaultModel: "gpt-5.6-luna",
      credentialNames: ["OPENAI_API_KEY"],
      capabilities: HARNESS_PROVIDER_CAPABILITIES,
      support: "certified"
    },
    diagnostics: { endpointEnvironmentVariable: "OPENAI_BASE_URL" },
    factory: ({ model, env, credentials }) => {
      const baseURL = env.OPENAI_BASE_URL?.trim();
      return createOpenAI({
        apiKey: credentials.require(),
        ...(baseURL ? { baseURL } : {})
      })(model);
    }
  },
  {
    descriptor: {
      id: "gemini",
      name: "Google Gemini",
      defaultModel: "gemini-3.6-flash",
      credentialNames: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
      capabilities: HARNESS_PROVIDER_CAPABILITIES,
      support: "provisional"
    },
    diagnostics: { endpointEnvironmentVariable: "GEMINI_BASE_URL" },
    factory: ({ model, env, credentials }) => {
      const baseURL = env.GEMINI_BASE_URL?.trim();
      return createGemini({
        apiKey: credentials.require(),
        ...(baseURL ? { baseURL } : {})
      })(model);
    }
  }
]);

export const DEFAULT_PROVIDER_REGISTRY = createProviderRegistry(BUILTIN_PROVIDER_REGISTRATIONS);
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = DEFAULT_PROVIDER_REGISTRY.descriptors;

export const providerModelInternals = {
  generatedToolCallId,
  withQwenDurableToolCallIds
};
