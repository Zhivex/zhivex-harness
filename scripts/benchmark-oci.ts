import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { resolveHarnessConfig } from "../src/config.js";
import {
  cleanupHarnessExecutionArtifacts,
  createHarnessOciExecutionEnvironment,
  type HarnessCommandResult,
  type HarnessEnvironmentStatus,
  type HarnessExecutionSession,
  type HarnessOciExecutionEnvironment,
  type OciPhaseLatencies
} from "../src/execution-environment.js";
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

const fileCount = integerOption("--files", 1_000, 10_000);
const commandCount = integerOption("--commands", 10, 50);
const batchCommandCount = integerOption("--batch-commands", 5, 32);
const repetitions = integerOption("--repetitions", 5, 50);
const warmups = integerOption("--warmups", 1, 10, 0);

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

const failedAttempt = <T>(error: string): Attempt<T> => ({ ok: false, durationMs: 0, error });
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

const validateCommand = (result: { exitCode: number; stdout: string; stderr: string }) => {
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `Command exited with ${result.exitCode}.`);
};

interface IterationResult {
  environmentInitialization: Attempt<HarnessOciExecutionEnvironment>;
  sessionAcquire: Attempt<HarnessExecutionSession>;
  firstCommand: Attempt<HarnessCommandResult>;
  reusedNoOpCommands: Attempt<HarnessCommandResult>[];
  batchCommand: Attempt<HarnessCommandResult>;
  mutationCommand: Attempt<HarnessCommandResult>;
  status: Attempt<HarnessEnvironmentStatus>;
  endToEndTti: Attempt<unknown>;
  completeScenario: Attempt<unknown>;
}

const summarizeCommandPhases = (commands: readonly Attempt<HarnessCommandResult>[]) => {
  const definitions: Array<[string, keyof OciPhaseLatencies]> = [
    ["hostSynchronization", "hostSynchronizationMs"],
    ["sessionCreation", "sessionCreationMs"],
    ["commandAndAttestation", "commandAndAttestationMs"],
    ["attestationCopy", "attestationCopyMs"],
    ["workspaceExport", "workspaceExportMs"],
    ["total", "totalMs"]
  ];
  return Object.fromEntries(definitions.map(([name, key]) => {
    const successfulCommands = commands.filter(
      (sample): sample is Extract<Attempt<HarnessCommandResult>, { ok: true }> => sample.ok
    );
    const phaseSamples: Attempt<unknown>[] = successfulCommands.flatMap((sample) => {
      const durationMs = sample.value.phaseLatencies?.[key];
      return durationMs === undefined ? [] : [{ ok: true as const, value: undefined, durationMs }];
    });
    const statistics = phaseSamples.length > 0 ? summarize(phaseSamples) : {
      samples: 0,
      successes: 0,
      failures: 0,
      successRate: null,
      minMs: null,
      p50Ms: null,
      medianMs: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null
    };
    return [name, {
      ...statistics,
      availableOnCommands: phaseSamples.length,
      unavailableOnSuccessfulCommands: successfulCommands.length - phaseSamples.length
    }];
  }));
};

const requireIterationSuccess = (result: IterationResult) => {
  const phases: Array<[string, Attempt<unknown>]> = [
    ["environment initialization", result.environmentInitialization],
    ["session acquisition", result.sessionAcquire],
    ["first command", result.firstCommand],
    ...result.reusedNoOpCommands.map((sample, index) => [`reused no-op command ${index + 1}`, sample] as [string, Attempt<unknown>]),
    ["batched no-op commands", result.batchCommand],
    ["mutation command", result.mutationCommand],
    ["status", result.status],
    ["end-to-end TTI", result.endToEndTti],
    ["complete scenario", result.completeScenario]
  ];
  const failed = phases.find(([, sample]) => !sample.ok);
  if (failed && !failed[1].ok) throw new Error(`OCI ${failed[0]} warmup failed: ${failed[1].error}`);
};

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "zhivex-oci-benchmark-"));
try {
  const sourceRoot = path.join(temporaryRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(temporaryRoot, "package.json"), JSON.stringify({
    name: "zhivex-oci-benchmark",
    private: true
  }));
  for (let offset = 0; offset < fileCount; offset += 250) {
    await Promise.all(Array.from(
      { length: Math.min(250, fileCount - offset) },
      (_, batchIndex) => {
        const index = offset + batchIndex;
        return writeFile(
          path.join(sourceRoot, `file-${String(index).padStart(6, "0")}.ts`),
          `export const fixture${index} = ${index};\n`,
          "utf8"
        );
      }
    ));
  }

  const config = resolveHarnessConfig({
    workspace: temporaryRoot,
    executionBackend: "oci",
    ociAllowedCommands: ["node", "npm"],
    ociMaxProcessRuntimeMs: 30_000,
    ociMaxMemoryMb: 256,
    ociMaxPids: 32,
    ociMaxCpus: 1,
    ociMaxWorkspaceBytes: 64 * 1024 * 1024,
    ociTmpfsMb: 64
  });
  if (config.execution.backend !== "oci") throw new Error("OCI benchmark configuration was not enabled.");

  let runtime: {
    name: string;
    version: string;
    imageDigest: string;
  } | undefined;

  const runIteration = async (iteration: number): Promise<IterationResult> => {
    const workspace = await Workspace.open(temporaryRoot);
    const ttiStartedAt = performance.now();
    const scenarioStartedAt = ttiStartedAt;
    let environment: HarnessOciExecutionEnvironment | undefined;
    let session: HarnessExecutionSession | undefined;

    let environmentInitialization: Attempt<HarnessOciExecutionEnvironment> = failedAttempt("Not attempted.");
    let sessionAcquire: Attempt<HarnessExecutionSession> = failedAttempt("Not attempted.");
    let firstCommand: Attempt<HarnessCommandResult> = failedAttempt("Not attempted.");
    const reusedNoOpCommands: Attempt<HarnessCommandResult>[] = [];
    let batchCommand: Attempt<HarnessCommandResult> = failedAttempt("Not attempted.");
    let mutationCommand: Attempt<HarnessCommandResult> = failedAttempt("Not attempted.");
    let status: Attempt<HarnessEnvironmentStatus> = failedAttempt("Not attempted.");
    let endToEndTti: Attempt<unknown> = failedAttempt("First command did not complete successfully.");
    let completeScenario: Attempt<unknown> = failedAttempt("Scenario did not complete successfully.");

    try {
      environmentInitialization = await attempt(() => createHarnessOciExecutionEnvironment({
        config: config.execution,
        workspace,
        stateDirectory: config.stateDirectory
      }));
      if (!environmentInitialization.ok) {
        sessionAcquire = failedAttempt("Skipped because environment initialization failed.");
        firstCommand = failedAttempt("Skipped because environment initialization failed.");
        mutationCommand = failedAttempt("Skipped because environment initialization failed.");
        batchCommand = failedAttempt("Skipped because environment initialization failed.");
        status = failedAttempt("Skipped because environment initialization failed.");
        return {
          environmentInitialization,
          sessionAcquire,
          firstCommand,
          reusedNoOpCommands,
          batchCommand,
          mutationCommand,
          status,
          endToEndTti,
          completeScenario
        };
      }
      environment = environmentInitialization.value;
      runtime = {
        name: environment.image.runtime,
        version: environment.image.runtimeVersion,
        imageDigest: environment.image.imageDigest
      };

      sessionAcquire = await attempt(() => environment!.acquire({
        runId: `oci-benchmark-${process.pid}-${iteration}`
      }) as Promise<HarnessExecutionSession>);
      if (!sessionAcquire.ok) {
        firstCommand = failedAttempt("Skipped because session acquisition failed.");
        mutationCommand = failedAttempt("Skipped because session acquisition failed.");
        batchCommand = failedAttempt("Skipped because session acquisition failed.");
        status = failedAttempt("Skipped because session acquisition failed.");
        return {
          environmentInitialization,
          sessionAcquire,
          firstCommand,
          reusedNoOpCommands,
          batchCommand,
          mutationCommand,
          status,
          endToEndTti,
          completeScenario
        };
      }
      session = sessionAcquire.value;

      firstCommand = await attempt(() => session!.runCommand("node", [
        "--input-type=module",
        "-e",
        "process.stdout.write('ok')"
      ]), validateCommand);
      if (firstCommand.ok) {
        endToEndTti = { ok: true, value: undefined, durationMs: performance.now() - ttiStartedAt };
      }

      for (let index = 1; index < commandCount; index += 1) {
        reusedNoOpCommands.push(await attempt(() => session!.runCommand("node", [
          "--input-type=module",
          "-e",
          "process.stdout.write('ok')"
        ]), validateCommand));
      }

      batchCommand = await attempt(() => session!.runCommandBatch(Array.from(
        { length: batchCommandCount },
        () => ({
          command: "node",
          args: ["--input-type=module", "-e", "process.stdout.write('ok')"]
        })
      )), validateCommand);

      mutationCommand = await attempt(() => session!.runCommand("node", [
        "--input-type=module",
        "-e",
        "import { writeFile } from 'node:fs/promises'; await writeFile('/workspace/src/generated.ts', 'export const generated = true;\\n')"
      ]), validateCommand);
      status = await attempt(() => session!.status());

      const allSucceeded = firstCommand.ok && reusedNoOpCommands.every((sample) => sample.ok) && batchCommand.ok &&
        mutationCommand.ok && status.ok;
      if (allSucceeded) {
        completeScenario = { ok: true, value: undefined, durationMs: performance.now() - scenarioStartedAt };
      } else {
        completeScenario = failedAttempt("At least one command or status phase failed.");
      }
      return {
        environmentInitialization,
        sessionAcquire,
        firstCommand,
        reusedNoOpCommands,
        batchCommand,
        mutationCommand,
        status,
        endToEndTti,
        completeScenario
      };
    } finally {
      await session?.release?.({ status: "completed" }).catch(() => undefined);
      await environment?.runtime.cleanupOrphans().catch(() => undefined);
      await cleanupHarnessExecutionArtifacts(config.stateDirectory, Date.now() + 1_000).catch(() => undefined);
    }
  };

  for (let index = 0; index < warmups; index += 1) {
    requireIterationSuccess(await runIteration(-(index + 1)));
  }

  const results: IterationResult[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    results.push(await runIteration(index + 1));
  }

  const environmentInitialization = summarize(results.map((result) => result.environmentInitialization));
  const sessionAcquire = summarize(results.map((result) => result.sessionAcquire));
  const firstCommand = summarize(results.map((result) => result.firstCommand));
  const reusedNoOpAttempts = results.flatMap((result) => result.reusedNoOpCommands);
  const reusedNoOpCommands = summarize(reusedNoOpAttempts);
  const batchCommand = summarize(results.map((result) => result.batchCommand));
  const mutationCommand = summarize(results.map((result) => result.mutationCommand));
  const status = summarize(results.map((result) => result.status));
  const endToEndTti = summarize(results.map((result) => result.endToEndTti));
  const completeScenario = summarize(results.map((result) => result.completeScenario));
  const successfulStatuses = results.flatMap((result) =>
    result.completeScenario.ok && result.status.ok ? [result.status.value] : []
  );
  const io = successfulStatuses.at(-1)?.io;

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    kind: "oci-benchmark",
    methodology: {
      repetitions,
      warmups,
      execution: "sequential",
      percentileMethod: "nearest-rank",
      percentileSampleCaveat: "Use at least 100 successful samples before treating p99 as representative.",
      fixtureSetupExcluded: true,
      workspaceOpenExcluded: true,
      hostFilesystemCache: "not-flushed",
      resultValidation: true,
      ttiDefinition: "environment inspection start through the successful first command response",
      phaseDefinitions: {
        environmentInitialization: "OCI runtime client creation plus local image inspection",
        sessionAcquire: "workspace snapshot, durable metadata, and isolated session acquisition",
        firstCommand: "first argv-only command including container start and workspace validation",
        reusedNoOpCommand: "subsequent no-op command using the acquired per-run container",
        batchCommand: "review-equivalent argv sequence executed with one final process check, attestation, and publication cycle",
        mutationCommand: "command mutation plus changed-workspace validation and publication",
        completeScenario: "environment initialization through status after all commands; cleanup excluded",
        commandPhaseLatencies: "runtime-reported attribution inside each command; optional phases are marked unavailable when not applicable"
      }
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
    fixture: {
      files: fileCount + 1,
      commands: commandCount,
      commandsPerRepetition: commandCount,
      reusedNoOpCommandsPerRepetition: Math.max(0, commandCount - 1),
      batchCommandsPerRepetition: batchCommandCount
    },
    runtime: runtime ?? null,
    measurements: {
      // These fields retain the v1 shape and now represent aggregate p50/statistics.
      environmentInitializationMs: environmentInitialization.p50Ms,
      acquireSnapshotMs: sessionAcquire.p50Ms,
      firstCommandMs: firstCommand.p50Ms,
      reusedNoOpCommands,
      batchCommandMs: batchCommand.p50Ms,
      mutationCommandMs: mutationCommand.p50Ms,
      endToEndTtiMs: endToEndTti.p50Ms,
      completeScenarioMs: completeScenario.p50Ms
    },
    statistics: {
      environmentInitialization,
      sessionAcquire,
      firstCommand,
      reusedNoOpCommands,
      batchCommand,
      mutationCommand,
      status,
      endToEndTti,
      completeScenario,
      allCommands: summarize(results.flatMap((result) => [
        result.firstCommand,
        ...result.reusedNoOpCommands,
        result.batchCommand,
        result.mutationCommand
      ])),
      commandPhaseLatencies: {
        firstCommand: summarizeCommandPhases(results.map((result) => result.firstCommand)),
        reusedNoOpCommands: summarizeCommandPhases(reusedNoOpAttempts),
        batchCommand: summarizeCommandPhases(results.map((result) => result.batchCommand)),
        mutationCommand: summarizeCommandPhases(results.map((result) => result.mutationCommand))
      }
    },
    io: io ?? null,
    ioPerSuccessfulRepetition: successfulStatuses.map((entry) => entry.io)
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
