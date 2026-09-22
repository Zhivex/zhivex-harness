/** Internal, co-versioned Desktop surface; not a public package entrypoint. */
export { createProviderModel } from "../../runtime/config.js";
export type { HarnessConfig } from "../../runtime/config.js";
export { resolveHarnessConfig } from "../../runtime/config.js";
export { DEFAULT_PROVIDER_REGISTRY } from "../../providers/providers.js";
export { PROVIDERS } from "../../providers/providers.js";

export { bundledModelCatalog, catalogModels, modelDescription } from "../../models/catalog.js";
export type { CatalogModel, ModelCatalog } from "../../models/catalog.js";
export { loadModelCatalog } from "../../models/catalog-store.js";
