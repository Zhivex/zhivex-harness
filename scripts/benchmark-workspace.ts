import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Workspace } from "../src/workspace.js";

const integerOption = (name: string, fallback: number, maximum: number, minimum = 1) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
};

const fileCount = integerOption("--files", 5_000, 50_000);
const pageSize = integerOption("--page-size", 200, 5_000);
const repetitions = integerOption("--repetitions", 5, 100);
const warmups = integerOption("--warmups", 1, 20, 0);

type Attempt<T> =
  | { ok: true; durationMs: number; value: T }
  | { ok: false; durationMs: number; error: string };

const attempt = async <T>(operation: () => Promise<T>, validate?: (value: T) => void): Promise<Attempt<T>> => {
  const startedAt = performance.now();
  try {
    const value = await operation();
    validate?.(value);
    return { ok: true, value, durationMs: performance.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const nearestRank = (sorted: readonly number[], percentile: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;

const summarize = (attempts: readonly Attempt<unknown>[]) => {
  const samples = attempts.filter((sample): sample is Extract<Attempt<unknown>, { ok: true }> => sample.ok)
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const successful = samples.length;
  const total = attempts.length;
  const p50Ms = nearestRank(samples, 0.5);
  return {
    samples: total,
    successes: successful,
    failures: total - successful,
    successRate: total > 0 ? Number((successful / total).toFixed(4)) : 0,
    minMs: Number((samples[0] ?? 0).toFixed(2)),
    p50Ms: Number(p50Ms.toFixed(2)),
    medianMs: Number(p50Ms.toFixed(2)),
    p95Ms: Number(nearestRank(samples, 0.95).toFixed(2)),
    p99Ms: Number(nearestRank(samples, 0.99).toFixed(2)),
    maxMs: Number((samples.at(-1) ?? 0).toFixed(2))
  };
};

const requireWarmupSuccess = (name: string, sample: Attempt<unknown>) => {
  if (!sample.ok) throw new Error(`${name} warmup failed: ${sample.error}`);
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

  const topologyFirstPageSamples: Attempt<unknown>[] = [];
  const topologyAllPagesSamples: Attempt<unknown>[] = [];
  const digestFirstPageSamples: Attempt<unknown>[] = [];
  const digestAllPagesSamples: Attempt<unknown>[] = [];
  const independentSearchSamples: Attempt<unknown>[] = [];
  const batchSearchSamples: Attempt<unknown>[] = [];
  const pairedSpeedups: number[] = [];
  let representativeDigestAllPages = { files: 0, pages: 0 };
  let representativeTopologyAllPages = { files: 0, pages: 0 };
  let diagnostics: ReturnType<Workspace["workspaceIndexDiagnostics"]> | undefined;

  const listAllPages = async (workspace: Workspace, includeDigests: boolean) => {
    let cursor: string | undefined;
    let files = 0;
    let pages = 0;
    do {
      const page = await workspace.listFiles(".", {
        limit: pageSize,
        includeDigests,
        ...(cursor ? { cursor } : {})
      });
      files += page.files.length;
      pages += 1;
      cursor = page.nextCursor;
    } while (cursor);
    return { files, pages };
  };

  const validatePage = (page: { files: readonly unknown[] }) => {
    if (page.files.length !== Math.min(fileCount, pageSize)) {
      throw new Error(`Expected ${Math.min(fileCount, pageSize)} files in the first page, received ${page.files.length}.`);
    }
  };
  const validateInventory = (result: { files: number }) => {
    if (result.files !== fileCount) {
      throw new Error(`Expected ${fileCount} files in the full inventory, received ${result.files}.`);
    }
  };

  const runIteration = async (record: boolean, iteration: number) => {
    // Fresh Workspace instances keep the application index cold per repetition.
    // Warmups only prime the runtime and the host filesystem cache.
    const topologyWorkspace = await Workspace.open(temporaryRoot);
    const topologyFirstPage = await attempt(
      () => topologyWorkspace.listFiles(".", { limit: pageSize, includeDigests: false }),
      validatePage
    );
    const topologyAllPages = await attempt(
      () => listAllPages(topologyWorkspace, false),
      validateInventory
    );

    const digestWorkspace = await Workspace.open(temporaryRoot);
    const digestFirstPage = await attempt(
      () => digestWorkspace.listFiles(".", { limit: pageSize, includeDigests: true }),
      validatePage
    );
    const digestAllPages = await attempt(
      () => listAllPages(digestWorkspace, true),
      validateInventory
    );
    const runIndependentSearches = () => attempt(async () => Promise.all([
      digestWorkspace.searchFiles("missing-token-a", "."),
      digestWorkspace.searchFiles("missing-token-b", "."),
      digestWorkspace.searchFiles("missing-token-c", ".")
    ]), (results) => {
      if (results.some((result) => result.matches.length !== 0)) {
        throw new Error("Independent missing-token searches unexpectedly returned matches.");
      }
    });
    const runBatchSearch = () => attempt(() => digestWorkspace.searchMany([
      { query: "missing-token-a" },
      { query: "missing-token-b" },
      { query: "missing-token-c" }
    ]), (result) => {
      if (result.results.length !== 3 || result.results.some((entry) => entry.matches.length !== 0)) {
        throw new Error("searchMany missing-token queries returned an invalid result.");
      }
    });
    // Alternate the paired-search order so residual filesystem caching does not
    // consistently favor the second implementation.
    const orderedSearches = iteration % 2 === 0
      ? [await runIndependentSearches(), await runBatchSearch()]
      : [await runBatchSearch(), await runIndependentSearches()].reverse();
    const [independentSearches, batchSearch] = orderedSearches;

    diagnostics = digestWorkspace.workspaceIndexDiagnostics();
    if (!record) {
      requireWarmupSuccess("topology first page", topologyFirstPage);
      requireWarmupSuccess("topology full inventory", topologyAllPages);
      requireWarmupSuccess("digest-bound first page", digestFirstPage);
      requireWarmupSuccess("digest-bound full inventory", digestAllPages);
      requireWarmupSuccess("independent searches", independentSearches);
      requireWarmupSuccess("searchMany", batchSearch);
      return;
    }

    topologyFirstPageSamples.push(topologyFirstPage);
    topologyAllPagesSamples.push(topologyAllPages);
    digestFirstPageSamples.push(digestFirstPage);
    digestAllPagesSamples.push(digestAllPages);
    independentSearchSamples.push(independentSearches);
    batchSearchSamples.push(batchSearch);
    if (topologyAllPages.ok) representativeTopologyAllPages = topologyAllPages.value;
    if (digestAllPages.ok) representativeDigestAllPages = digestAllPages.value;
    if (independentSearches.ok && batchSearch.ok && batchSearch.durationMs > 0) {
      pairedSpeedups.push(independentSearches.durationMs / batchSearch.durationMs);
    }
  };

  for (let index = 0; index < warmups; index += 1) await runIteration(false, index);
  for (let index = 0; index < repetitions; index += 1) await runIteration(true, warmups + index);

  const topologyFirstPage = summarize(topologyFirstPageSamples);
  const topologyAllPages = summarize(topologyAllPagesSamples);
  const digestFirstPage = summarize(digestFirstPageSamples);
  const digestAllPages = summarize(digestAllPagesSamples);
  const independentSearches = summarize(independentSearchSamples);
  const batchSearch = summarize(batchSearchSamples);
  const speedup = pairedSpeedups.length > 0
    ? nearestRank([...pairedSpeedups].sort((left, right) => left - right), 0.5)
    : 0;

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    kind: "workspace-benchmark",
    methodology: {
      repetitions,
      warmups,
      execution: "sequential",
      percentileMethod: "nearest-rank",
      percentileSampleCaveat: "Use at least 100 successful samples before treating p99 as representative.",
      fixtureSetupExcluded: true,
      workspaceOpenExcluded: true,
      workspaceIndexState: "cold-first-page-then-reused-within-repetition",
      hostFilesystemCache: "not-flushed",
      pairedSearchOrder: "alternating",
      resultValidation: true
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      nodeVersion: process.version,
      bunVersion: process.versions.bun ?? null
    },
    fixture: { files: fileCount, pageSize },
    measurements: {
      // These scalar fields retain the v1 shape and now represent digest-bound p50.
      firstPageMs: digestFirstPage.p50Ms,
      allPagesMs: digestAllPages.p50Ms,
      allPages: representativeDigestAllPages,
      topologyFirstPageMs: topologyFirstPage.p50Ms,
      topologyAllPagesMs: topologyAllPages.p50Ms,
      topologyAllPages: representativeTopologyAllPages,
      threeIndependentSearchesMs: independentSearches.p50Ms,
      searchManyMs: batchSearch.p50Ms,
      searchManySpeedup: pairedSpeedups.length > 0 ? Number(speedup.toFixed(2)) : null
    },
    statistics: {
      topologyFirstPage,
      topologyAllPages,
      digestBoundFirstPage: digestFirstPage,
      digestBoundAllPages: digestAllPages,
      threeIndependentSearches: independentSearches,
      searchMany: batchSearch,
      pairedSearchManySpeedup: {
        samples: pairedSpeedups.length,
        p50: pairedSpeedups.length > 0 ? Number(speedup.toFixed(2)) : null
      }
    },
    diagnostics
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
