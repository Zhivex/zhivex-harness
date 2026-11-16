/** Internal, co-versioned Desktop surface; not a public package entrypoint. */
export { createProviderModel } from "../../runtime/config.js";
export type { HarnessConfig } from "../../runtime/config.js";
export { resolveHarnessConfig } from "../../runtime/config.js";
export { DEFAULT_PROVIDER_REGISTRY } from "../../providers/providers.js";
export { PROVIDERS } from "../../providers/providers.js";
export { vertexConfigured, vertexEnvironment, vertexTokenSource, vertexRoute } from "../../providers/vertex-auth.js";
export { bedrockConfigured, bedrockEnvironment, bedrockOpenAIBaseURL, bedrockRegion, bedrockRuntime } from "../../providers/bedrock.js";
export { azureOpenAIConfigured, azureOpenAIEnvironment, azureOpenAIEndpoint, azureOpenAIApiVersion, azureOpenAIDeployments } from "../../providers/azure-openai.js";

export { bundledModelCatalog, catalogModels, modelDescription } from "../../models/catalog.js";
export type { CatalogModel, ModelCatalog } from "../../models/catalog.js";
export { loadModelCatalog } from "../../models/catalog-store.js";
