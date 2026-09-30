import { createProviderModel } from "@zhivex-ai/harness/engine";
import { vertexConfigured } from "@zhivex-ai/harness/desktop/v1/providers";
import type {LanguageModel} from "@zhivex-ai/agents";
import type {DesktopModelSelection} from "./bridge.js";
import {modelSelectionSchema,providerEnvironment} from "./model-selection.js";

/** Opening history must not require an API key. The unconfigured model has no callable transport. */
export function desktopProviderModel(value: DesktopModelSelection, secret?: string, host: NodeJS.ProcessEnv = process.env): LanguageModel {
    const selection = modelSelectionSchema.parse(value);
    if (selection.provider === "vertex") {
        const env = providerEnvironment(selection, undefined, host);
        if (vertexConfigured(env)) return createProviderModel(selection, env);
        const unavailable = async (): Promise<never> => { throw new Error("MODEL_CREDENTIAL_REQUIRED"); };
        const metadata = createProviderModel(selection, { GOOGLE_CLOUD_PROJECT: "desktop-unconfigured", VERTEX_LOCATION: "global" });
        return { provider: "vertex", modelId: selection.model, capabilities: metadata.capabilities, generate: unavailable, stream: unavailable };
    }
    const model = createProviderModel(selection, providerEnvironment(selection, secret ?? "desktop-unconfigured"));
    if (secret) return model;
    const unavailable = async (): Promise<never> => {throw new Error("MODEL_CREDENTIAL_REQUIRED");};
    // Only copy metadata, never a bound request method or client holding the placeholder.
    return {provider:model.provider,modelId:model.modelId,capabilities:model.capabilities,generate:unavailable,stream:unavailable};
}
