import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { resolveHarnessConfig } from "../src/config.js";
import {
  cleanupHarnessExecutionArtifacts,
  createHarnessOciExecutionEnvironment,
  type HarnessExecutionSession,
  type HarnessOciExecutionEnvironment
} from "../src/execution-environment.js";
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

const fileCount = integerOption("--files", 1_000, 10_000);
const commandCount = integerOption("--commands", 10, 50);

const measure = async <T>(operation: () => Promise<T>) => {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - startedAt };
};

const summarize = (samples: readonly number[]) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    medianMs: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2)),
    p95Ms: Number((sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2))
  };
};

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "zhivex-oci-benchmark-"));
let environment: HarnessOciExecutionEnvironment | undefined;
let session: HarnessExecutionSession | undefined;
let stateDirectory: string | undefined;

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

  const workspace = await Workspace.open(temporaryRoot);
  const config = resolveHarnessConfig({
    workspace: temporaryRoot,
    executionBackend: "oci",
    ociAllowedCommands: ["bun"],
    ociMaxProcessRuntimeMs: 30_000,
    ociMaxMemoryMb: 256,
    ociMaxPids: 32,
    ociMaxCpus: 1,
    ociMaxWorkspaceBytes: 64 * 1024 * 1024,
    ociTmpfsMb: 64
  });
  if (config.execution.backend !== "oci") throw new Error("OCI benchmark configuration was not enabled.");
  stateDirectory = config.stateDirectory;

  const initialized = await measure(() => createHarnessOciExecutionEnvironment({
    config: config.execution,
    workspace,
    stateDirectory: config.stateDirectory
  }));
  environment = initialized.value;
  const acquired = await measure(() => environment!.acquire({ runId: "oci-benchmark-run" }));
  session = acquired.value as HarnessExecutionSession;

  const commandSamples: number[] = [];
  for (let index = 0; index < commandCount; index += 1) {
    const command = await measure(() => session!.runCommand("bun", [
      "-e",
      "process.stdout.write('ok')"
    ]));
    if (command.value.exitCode !== 0) throw new Error(command.value.stderr || command.value.stdout);
    commandSamples.push(command.durationMs);
  }
  const mutation = await measure(() => session!.runCommand("bun", [
    "-e",
    "await Bun.write('/workspace/src/generated.ts', 'export const generated = true;\\n')"
  ]));
  if (mutation.value.exitCode !== 0) throw new Error(mutation.value.stderr || mutation.value.stdout);
  const status = await session.status();

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "oci-benchmark",
    fixture: { files: fileCount + 1, commands: commandCount },
    runtime: {
      name: environment.image.runtime,
      version: environment.image.runtimeVersion,
      imageDigest: environment.image.imageDigest
    },
    measurements: {
      environmentInitializationMs: Number(initialized.durationMs.toFixed(2)),
      acquireSnapshotMs: Number(acquired.durationMs.toFixed(2)),
      firstCommandMs: Number((commandSamples[0] ?? 0).toFixed(2)),
      reusedNoOpCommands: summarize(commandSamples.slice(1)),
      mutationCommandMs: Number(mutation.durationMs.toFixed(2))
    },
    io: status.io
  }, null, 2)}\n`);
} finally {
  await session?.release?.({ status: "completed" }).catch(() => undefined);
  await environment?.runtime.cleanupOrphans().catch(() => undefined);
  if (stateDirectory) {
    await cleanupHarnessExecutionArtifacts(stateDirectory, Date.now() + 1_000).catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
