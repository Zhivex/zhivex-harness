import { z } from "zod";
import { bundledModelCatalog, catalogModels, type ModelCatalog } from "@zhivex-ai/harness/models";
import { PROVIDERS, DEFAULT_PROVIDER_REGISTRY } from "@zhivex-ai/harness/engine";
import { vertexEnvironment } from "@zhivex-ai/harness/desktop/v1/providers";
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
export function providerEnvironment(selection: DesktopModelSelection, secret?: string, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const parsed = modelSelectionSchema.parse(selection);
    if (parsed.provider === "vertex") return vertexEnvironment(host);
    const credential = DEFAULT_PROVIDER_REGISTRY.descriptor(parsed.provider).credentialNames[0]!;
    return secret ? {[credential]: secret} : {};
}
