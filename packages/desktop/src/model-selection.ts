import { z } from "zod";
import { bundledModelCatalog, catalogModels, type ModelCatalog } from "@zhivex-ai/harness/models";
import { PROVIDERS, DEFAULT_PROVIDER_REGISTRY } from "@zhivex-ai/harness/engine";
import { azureOpenAIEnvironment, bedrockEnvironment, vertexEnvironment } from "@zhivex-ai/harness/desktop/v1/providers";
import type { DesktopModelSelection, DesktopProvider } from "./bridge.js";

export const modelSelectionSchema = z.object({
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
}).strict();
export const defaultModelSelection = (): DesktopModelSelection => ({provider: "openai", model: DEFAULT_PROVIDER_REGISTRY.descriptor("openai").defaultModel});
export const desktopProviders = (catalog: ModelCatalog = bundledModelCatalog): DesktopProvider[] => DEFAULT_PROVIDER_REGISTRY.descriptors.map(p => ({
    id: p.id, name: p.name, defaultModel: catalog.providers.find(entry => entry.id === p.id)?.defaultModel ?? p.defaultModel, support: p.support,
    models: catalogModels(catalog, p.id), catalogRevision: catalog.revision
}));
export const DESKTOP_BOOTSTRAP_CREDENTIAL_NAMES = [
    "AZURE_OPENAI_API_KEY",
    "BEDROCK_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN"
] as const;

const DESKTOP_BOOTSTRAP_CREDENTIALS = {
    "azure-openai": ["AZURE_OPENAI_API_KEY"],
    bedrock: ["BEDROCK_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]
} as const;

/** Credentials the Desktop worker must receive after its process environment drops secrets. */
export function desktopBootstrapCredentials(selection: DesktopModelSelection, keychainSecret: string | undefined, host: NodeJS.ProcessEnv): Record<string, string> {
    const parsed = modelSelectionSchema.parse(selection);
    const names = DESKTOP_BOOTSTRAP_CREDENTIALS[parsed.provider as keyof typeof DESKTOP_BOOTSTRAP_CREDENTIALS];
    if (!names) return {};
    const openaiRuntime = parsed.provider === "bedrock" && host.BEDROCK_RUNTIME?.trim() === "openai";
    const picked: Record<string, string> = {};
    for (const name of names) {
        if (keychainSecret && parsed.provider === "azure-openai") continue;
        if (openaiRuntime && (name === "AWS_ACCESS_KEY_ID" || name === "AWS_SECRET_ACCESS_KEY" || name === "AWS_SESSION_TOKEN")) continue;
        if (keychainSecret && openaiRuntime && (name === "BEDROCK_API_KEY" || name === "AWS_BEARER_TOKEN_BEDROCK")) continue;
        const value = host[name]?.trim();
        if (value && value.length <= 8192) picked[name] = value;
    }
    return picked;
}

export function providerEnvironment(selection: DesktopModelSelection, secret?: string, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const parsed = modelSelectionSchema.parse(selection);
    if (parsed.provider === "vertex") return vertexEnvironment(host);
    if (parsed.provider === "bedrock") return bedrockEnvironment(host, secret);
    if (parsed.provider === "azure-openai") return azureOpenAIEnvironment(host, secret);
    const credential = DEFAULT_PROVIDER_REGISTRY.descriptor(parsed.provider).credentialNames[0]!;
    return secret ? {[credential]: secret} : {};
}
