/** Host-only integration helpers; never import this entrypoint from a renderer. */
export { loadModelCatalog } from "../models/catalog-store.js";
export type { CatalogLoadOptions, CatalogSnapshot } from "../models/catalog-store.js";
export { vertexConfigured, vertexEnvironment, vertexTokenSource, vertexRoute } from "../providers/vertex-auth.js";
