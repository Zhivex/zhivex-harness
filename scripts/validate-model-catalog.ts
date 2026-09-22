import { modelCatalogSchema } from "../src/models/catalog.js";
const file = process.argv[2] ?? new URL("../src/models/catalog.json", import.meta.url);
const catalog = modelCatalogSchema.parse(await Bun.file(file).json());
console.log(`Valid model catalog ${catalog.revision}: ${catalog.providers.reduce((n, p) => n + p.models.length, 0)} models.`);
