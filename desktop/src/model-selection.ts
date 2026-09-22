import { z } from "zod";
import { PROVIDERS, DEFAULT_PROVIDER_REGISTRY } from "../../src/internal/desktop/providers.js";
import type { DesktopModelSelection, DesktopProvider } from "./bridge.js";

export const modelSelectionSchema = z.object({
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
}).strict();
export const defaultModelSelection = (): DesktopModelSelection => ({provider: "openai", model: DEFAULT_PROVIDER_REGISTRY.descriptor("openai").defaultModel});
export const desktopProviders = (): DesktopProvider[] => DEFAULT_PROVIDER_REGISTRY.descriptors.map(p => ({
    id: p.id, name: p.name, defaultModel: p.defaultModel, support: p.support
}));
export function providerEnvironment(selection: DesktopModelSelection, secret?: string): NodeJS.ProcessEnv {
    const parsed = modelSelectionSchema.parse(selection);
    const credential = DEFAULT_PROVIDER_REGISTRY.descriptor(parsed.provider).credentialNames[0]!;
    return secret ? {[credential]: secret} : {};
}
