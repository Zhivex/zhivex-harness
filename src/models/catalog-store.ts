import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { bundledModelCatalog, modelCatalogSchema, type ModelCatalog } from "./catalog.js";

const MAX_BYTES = 1024 * 1024;
const TTL = 60 * 60 * 1000;
export interface CatalogLoadOptions {
  url?: string;
  cacheDirectory?: string;
  fetcher?: (input: URL, init: RequestInit) => Promise<Response>;
  now?: number;
  refresh?: boolean;
}
export interface CatalogSnapshot {
  catalog: ModelCatalog;
  source: "bundled" | "cache" | "remote";
  stale: boolean;
}
/** Remote data is metadata only: never credentials, endpoints, executable code or adapter definitions. */
export async function loadModelCatalog(options: CatalogLoadOptions = {}): Promise<CatalogSnapshot> {
  const fallback: CatalogSnapshot = {catalog: bundledModelCatalog, source: "bundled", stale: false};
  const source = options.url ?? process.env.ZHIVEX_MODEL_CATALOG_URL;
  if (!source) return fallback;
  let url: URL;
  try {
    url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return {...fallback, stale: true};
  } catch { return {...fallback, stale: true}; }
  const now = options.now ?? Date.now();
  const directory = options.cacheDirectory ?? path.join(homedir(), ".zhivex", "model-catalog");
  const file = path.join(directory, `${createHash("sha256").update(url.href).digest("hex")}.json`);
  let cached: CatalogSnapshot | undefined;
  try {
    const raw = await readFile(file, "utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES + 1024) throw new Error("CATALOG_TOO_LARGE");
    const envelope = JSON.parse(raw);
    if (envelope.url !== url.href || !Number.isFinite(envelope.fetchedAt)) throw new Error("INVALID_CACHE");
    cached = {catalog: modelCatalogSchema.parse(envelope.catalog), source: "cache", stale: true};
    if (!options.refresh && now >= envelope.fetchedAt && now - envelope.fetchedAt < TTL) return {...cached, stale: false};
  } catch { /* Invalid caches never replace the bundled catalog. */ }
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      signal: AbortSignal.timeout(3000), redirect: "error", headers: {accept: "application/json"},
    });
    if (!response.ok || !response.body) throw new Error("CATALOG_FETCH_FAILED");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("CATALOG_TOO_LARGE");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const catalog = modelCatalogSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, {recursive: true, mode: 0o700});
      await writeFile(temporary, JSON.stringify({url: url.href, fetchedAt: now, catalog}), {mode: 0o600, flag: "wx"});
      await rename(temporary, file);
    } catch { /* A read-only cache must not prevent using a validated response. */ }
    finally { await unlink(temporary).catch(() => {}); }
    return {catalog, source: "remote", stale: false};
  } catch { return cached ?? {...fallback, stale: true}; }
}
