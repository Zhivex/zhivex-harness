/** Import SDK suggestions without overwriting centrally curated policy or removing historical models. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledModelCatalog, modelCatalogSchema } from "../src/models/catalog.js";
const root = process.argv[2];
if (!root) throw new Error("Usage: bun scripts/generate-console-models.ts <sdk-checkout>");
const catalog = structuredClone(bundledModelCatalog);
for (const provider of catalog.providers) {
  const source = path.join(root, `packages/sdk/src/catalog/providers/${provider.id}.ts`);
  const module = await import(pathToFileURL(source).href);
  const fragment = module[`${provider.id}CatalogFragment`];
  for (const entry of fragment.entries as {modelId: string; recommendedFor?: string[]}[]) {
    if (!entry.recommendedFor?.includes("chat") || !entry.recommendedFor.includes("tools") ||
      /(?:realtime|live|image|audio|tts|asr|embedding|rerank)/i.test(entry.modelId) ||
      provider.models.some(model => model.id === entry.modelId)) continue;
    provider.models.push({id: entry.modelId, name: entry.modelId, group: "other", order: provider.models.length,
      lifecycle: "unknown", validation: "unverified", capabilities: ["chat", "tools"]});
  }
}
catalog.revision = new Date().toISOString().replace(/[:]/g, "-");
await Bun.write(new URL("../src/models/catalog.json", import.meta.url), JSON.stringify(modelCatalogSchema.parse(catalog), null, 2) + "\n");
