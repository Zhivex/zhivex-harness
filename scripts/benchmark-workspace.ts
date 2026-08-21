import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Workspace } from "../src/workspace.js";

const integerOption = (name: string, fallback: number, maximum: number) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
};

const fileCount = integerOption("--files", 5_000, 50_000);
const pageSize = integerOption("--page-size", 200, 5_000);

const measure = async <T>(operation: () => Promise<T>) => {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: Number((performance.now() - startedAt).toFixed(2)) };
};

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "zhivex-workspace-benchmark-"));
try {
  const sourceRoot = path.join(temporaryRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  const batchSize = 250;
  for (let offset = 0; offset < fileCount; offset += batchSize) {
    await Promise.all(Array.from(
      { length: Math.min(batchSize, fileCount - offset) },
      (_, batchIndex) => {
        const index = offset + batchIndex;
        return writeFile(
          path.join(sourceRoot, `file-${String(index).padStart(6, "0")}.ts`),
          `export const fixture${index} = ${index};\n// common-token group-${index % 10}\n`,
          "utf8"
        );
      }
    ));
  }

  const workspace = await Workspace.open(temporaryRoot);
  const firstPage = await measure(() => workspace.listFiles(".", { limit: pageSize }));
  const allPages = await measure(async () => {
    let cursor: string | undefined;
    let files = 0;
    let pages = 0;
    do {
      const page = await workspace.listFiles(".", {
        limit: pageSize,
        ...(cursor ? { cursor } : {})
      });
      files += page.files.length;
      pages += 1;
      cursor = page.nextCursor;
    } while (cursor);
    return { files, pages };
  });
  const independentSearches = await measure(async () => Promise.all([
    workspace.searchFiles("missing-token-a", "."),
    workspace.searchFiles("missing-token-b", "."),
    workspace.searchFiles("missing-token-c", ".")
  ]));
  const batchSearch = await measure(() => workspace.searchMany([
    { query: "missing-token-a" },
    { query: "missing-token-b" },
    { query: "missing-token-c" }
  ]));

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "workspace-benchmark",
    fixture: { files: fileCount, pageSize },
    measurements: {
      firstPageMs: firstPage.durationMs,
      allPagesMs: allPages.durationMs,
      allPages: allPages.value,
      threeIndependentSearchesMs: independentSearches.durationMs,
      searchManyMs: batchSearch.durationMs,
      searchManySpeedup: batchSearch.durationMs > 0
        ? Number((independentSearches.durationMs / batchSearch.durationMs).toFixed(2))
        : null
    },
    diagnostics: workspace.workspaceIndexDiagnostics()
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
