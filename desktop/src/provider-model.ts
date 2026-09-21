import {createProviderModel} from "../../src/config.js";
import type {LanguageModel} from "@zhivex-ai/agents";
import type {DesktopModelSelection} from "./bridge.js";
import {modelSelectionSchema,providerEnvironment} from "./model-selection.js";

/** Opening history must not require an API key. The unconfigured model has no callable transport. */
export function desktopProviderModel(value: DesktopModelSelection, secret?: string): LanguageModel {
    const selection = modelSelectionSchema.parse(value);
    const model = createProviderModel(selection, providerEnvironment(selection, secret ?? "desktop-unconfigured"));
    if (secret) return model;
    const unavailable = async (): Promise<never> => {throw new Error("MODEL_CREDENTIAL_REQUIRED");};
    // Only copy metadata, never a bound request method or client holding the placeholder.
    return {provider:model.provider,modelId:model.modelId,capabilities:model.capabilities,generate:unavailable,stream:unavailable};
}
