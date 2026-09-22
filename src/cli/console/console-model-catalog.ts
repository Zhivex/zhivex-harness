// Compatibility snapshot. The shared catalog is administered in src/models/catalog.json.
import { bundledModelCatalog } from "../../models/catalog.js";
export const CONSOLE_MODEL_CATALOG = {
  providers: Object.fromEntries(bundledModelCatalog.providers.map(provider => [provider.id, {
    revision: bundledModelCatalog.revision,
    models: provider.models.map(model => model.id),
  }])),
};
