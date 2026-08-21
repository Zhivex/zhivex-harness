import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface RateAggregate {
  successes: number;
  samples: number;
  rate: number | null;
  wilson95: { low: number; high: number } | null;
}

interface ProfileAggregate {
  profile: string;
  variant: string;
  runs: number;
  safeResolved: RateAggregate;
  utilityPass: RateAggregate;
  attackAttempted: RateAggregate;
  attackCompleted: RateAggregate;
  environmentFailure: RateAggregate;
  unauthorizedEffectFree: RateAggregate;
  duration: { p50Ms: number; p95Ms: number; p99Ms: number };
  timeToSafeFix: { p50Ms: number; p95Ms: number; p99Ms: number };
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  approvals: number;
}

interface BenchmarkReport {
  schemaVersion: number;
  kind: string;
  generatedAt: string;
  dataset: { name: string; tasks: number };
  methodology: Record<string, unknown>;
  matrix: {
    profiles: string[];
    carriers: string[];
    repetitions: number;
    plannedRuns: number;
    completedRuns: number;
  };
  aggregates: ProfileAggregate[];
  matchedOverheadVsDirect: Array<{
    profile: string;
    pairs: number;
    durationRatio: { p50: number; p95: number; p99: number; unit: string };
  }>;
  samples?: Array<{
    profile: string;
    efficiency?: {
      activeToolDefinitions: number;
      modelTurns: number;
      compactions: number;
      approvalRounds: unknown[];
    };
  }>;
}

interface RunMetadata {
  schemaVersion: number;
  kind: string;
  recordedAt: string;
  evidenceStatus: string;
  report: { sha256: string };
  dataset: { sha256: string };
  model: {
    provider: string;
    id: string;
    reasoning: string;
    maxSteps: number;
    maxToolCalls: number;
    maxOutputTokens: number;
  };
  execution: {
    runtime: string;
    imageReference: string;
    imageId: string;
    imageInputSha256: string;
    network: string;
    approvalDelayMs: number;
  };
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} argument.`);
  }
  return value;
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function average(total: number, runs: number): number {
  return Number((total / runs).toFixed(4));
}

const reportPath = path.resolve(argumentValue("--report"));
const metadataPath = path.resolve(argumentValue("--metadata"));
const outputPath = path.resolve(argumentValue("--out"));
const [reportContents, metadataContents] = await Promise.all([
  readFile(reportPath, "utf8"),
  readFile(metadataPath, "utf8")
]);
const report = JSON.parse(reportContents) as BenchmarkReport;
const metadata = JSON.parse(metadataContents) as RunMetadata;

if (report.schemaVersion !== 1 || report.kind !== "time-to-safe-fix-report") {
  throw new Error("Unsupported Time-to-Safe-Fix report contract.");
}
if (metadata.schemaVersion !== 1 || metadata.kind !== "time-to-safe-fix-run-metadata") {
  throw new Error("Unsupported Time-to-Safe-Fix metadata contract.");
}
const actualReportSha256 = sha256(reportContents);
if (metadata.report.sha256 !== actualReportSha256) {
  throw new Error(
    `Report digest mismatch: metadata=${metadata.report.sha256} actual=${actualReportSha256}.`
  );
}

const profiles = report.aggregates
  .filter((aggregate) => aggregate.variant === "all")
  .map((aggregate) => {
    const efficiencyRecords = (report.samples ?? [])
      .filter((sample) => sample.profile === aggregate.profile)
      .flatMap((sample) => sample.efficiency ? [sample.efficiency] : []);
    return {
      profile: aggregate.profile,
      observedRuns: aggregate.runs,
      attackedRuns: aggregate.attackCompleted.samples,
      safeResolvedSuccesses: aggregate.safeResolved.successes,
      safeResolvedRate: aggregate.safeResolved.rate,
      safeResolvedWilson95: aggregate.safeResolved.wilson95,
      utilityPassSuccesses: aggregate.utilityPass.successes,
      attackAttempted: aggregate.attackAttempted.successes,
      attackCompleted: aggregate.attackCompleted.successes,
      unauthorizedEffects: aggregate.runs - aggregate.unauthorizedEffectFree.successes,
      environmentFailures: aggregate.environmentFailure.successes,
      durationMs: {
        p50: aggregate.timeToSafeFix.p50Ms,
        p95: aggregate.timeToSafeFix.p95Ms,
        p99: aggregate.timeToSafeFix.p99Ms
      },
      averagePerRun: {
        promptTokens: average(aggregate.promptTokens, aggregate.runs),
        completionTokens: average(aggregate.completionTokens, aggregate.runs),
        totalTokens: average(aggregate.promptTokens + aggregate.completionTokens, aggregate.runs),
        toolCalls: average(aggregate.toolCalls, aggregate.runs),
        approvals: average(aggregate.approvals, aggregate.runs)
      },
      ...(efficiencyRecords.length > 0 ? {
        efficiency: {
          observedRuns: efficiencyRecords.length,
          activeToolDefinitions: average(
            efficiencyRecords.reduce((total, record) => total + record.activeToolDefinitions, 0),
            efficiencyRecords.length
          ),
          modelTurns: average(
            efficiencyRecords.reduce((total, record) => total + record.modelTurns, 0),
            efficiencyRecords.length
          ),
          approvalRounds: average(
            efficiencyRecords.reduce((total, record) => total + record.approvalRounds.length, 0),
            efficiencyRecords.length
          ),
          compactions: average(
            efficiencyRecords.reduce((total, record) => total + record.compactions, 0),
            efficiencyRecords.length
          )
        }
      } : {})
    };
  });

if (profiles.length !== report.matrix.profiles.length) {
  throw new Error("The report does not contain one all-variant aggregate for every profile.");
}

const baseline = {
  schemaVersion: 1,
  kind: "time-to-safe-fix-baseline",
  recordedDate: metadata.recordedAt.slice(0, 10),
  evidenceStatus: metadata.evidenceStatus,
  source: {
    reportSha256: actualReportSha256,
    datasetSha256: metadata.dataset.sha256
  },
  dataset: report.dataset,
  model: metadata.model,
  execution: {
    runtime: metadata.execution.runtime,
    imageReference: metadata.execution.imageReference,
    imageId: metadata.execution.imageId,
    imageInputSha256: metadata.execution.imageInputSha256,
    network: metadata.execution.network,
    approvalDelayMs: metadata.execution.approvalDelayMs
  },
  methodology: report.methodology,
  matrix: report.matrix,
  profiles,
  matchedOverheadVsDirect: report.matchedOverheadVsDirect.map((aggregate) => ({
    profile: aggregate.profile,
    pairs: aggregate.pairs,
    durationRatio: {
      unit: aggregate.durationRatio.unit,
      p50: aggregate.durationRatio.p50,
      p95: aggregate.durationRatio.p95,
      p99: aggregate.durationRatio.p99
    }
  })),
  evidenceBoundary: [
    `Local observation from ${report.dataset.tasks} synthetic task${report.dataset.tasks === 1 ? "" : "s"}; not a RepoGuardBench score.`,
    "Confidence intervals are retained; tail latency remains specific to this local run.",
    "Raw samples, host details, worktree paths, and the invocation command are intentionally omitted."
  ]
};

await mkdir(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
await rename(temporaryPath, outputPath);
process.stdout.write(`Wrote sanitized baseline to ${outputPath}\n`);
