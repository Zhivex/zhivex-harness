import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createProviderModel,
  parseProvider,
  resolveHarnessConfig,
  type HarnessProvider
} from "../src/config.js";
import type { HarnessExecutionConfig } from "../src/config.js";
import { runDirectProfile } from "./time-to-safe-fix-direct-profile.js";
import {
  readTimeToSafeFixDriverRequest,
  renderTimeToSafeFixDriverResult,
  type TimeToSafeFixDriverRequest
} from "./time-to-safe-fix-driver-contract.js";
import {
  runGovernedTimeToSafeFixProfile,
  type TimeToSafeFixVerifierCommand
} from "./time-to-safe-fix-governed-profile.js";

interface DriverOptions {
  provider: HarnessProvider;
  model?: string;
  ociRuntime: "docker" | "podman";
  ociImage?: string;
  allowedCommands: string[];
  verifierCommand?: string;
  verifierArgs: string[];
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number;
  timeoutMs: number;
  approvalDelayMs: number;
  ociMaxProcessRuntimeMs: number;
  ociMaxProcessOutputBytes: number;
  ociMaxMemoryMb: number;
  ociMaxPids: number;
  ociMaxCpus: number;
  ociMaxWorkspaceBytes: number;
  ociMaxFileWriteBytes: number;
  ociTmpfsMb: number;
}

const integer = (value: string | undefined, name: string, fallback: number, minimum: number, maximum: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

const valueAfter = (args: readonly string[], index: number, name: string) => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
};

export const parseZhivexDriverOptions = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): DriverOptions => {
  let providerValue = env.ZHIVEX_SAFE_FIX_PROVIDER ?? env.ZHIVEX_HARNESS_PROVIDER;
  let model = env.ZHIVEX_SAFE_FIX_MODEL ?? env.ZHIVEX_HARNESS_MODEL;
  let ociRuntime: "docker" | "podman" = "docker";
  let ociImage = env.ZHIVEX_SAFE_FIX_OCI_IMAGE ?? env.ZHIVEX_HARNESS_OCI_IMAGE ??
    "zhivex-harness/time-to-safe-fix:node24-pytest9";
  const allowedCommands: string[] = [];
  let verifierCommand: string | undefined;
  const verifierArgs: string[] = [];
  let maxSteps = 24;
  let maxToolCalls = 64;
  let maxTokens = 8_192;
  let timeoutMs = 300_000;
  let approvalDelayMs = 0;
  let ociMaxProcessRuntimeMs = 120_000;
  let ociMaxProcessOutputBytes = 100_000;
  let ociMaxMemoryMb = 1_024;
  let ociMaxPids = 128;
  let ociMaxCpus = 2;
  let ociMaxWorkspaceBytes = 128 * 1024 * 1024;
  let ociMaxFileWriteBytes = 4 * 1024 * 1024;
  let ociTmpfsMb = 256;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--provider") providerValue = valueAfter(args, index++, arg);
    else if (arg === "--model") model = valueAfter(args, index++, arg);
    else if (arg === "--oci-runtime") {
      const runtime = valueAfter(args, index++, arg);
      if (runtime !== "docker" && runtime !== "podman") throw new Error("--oci-runtime must be docker or podman.");
      ociRuntime = runtime;
    } else if (arg === "--oci-image") ociImage = valueAfter(args, index++, arg);
    else if (arg === "--allowed-command") allowedCommands.push(valueAfter(args, index++, arg));
    else if (arg === "--verifier-command") verifierCommand = valueAfter(args, index++, arg);
    else if (arg === "--verifier-arg") verifierArgs.push(valueAfter(args, index++, arg));
    else if (arg === "--max-steps") maxSteps = integer(valueAfter(args, index++, arg), arg, maxSteps, 1, 50);
    else if (arg === "--max-tool-calls") maxToolCalls = integer(valueAfter(args, index++, arg), arg, maxToolCalls, 1, 500);
    else if (arg === "--max-tokens") maxTokens = integer(valueAfter(args, index++, arg), arg, maxTokens, 1, 1_000_000);
    else if (arg === "--timeout-ms") timeoutMs = integer(valueAfter(args, index++, arg), arg, timeoutMs, 1_000, 3_600_000);
    else if (arg === "--approval-delay-ms") approvalDelayMs = integer(valueAfter(args, index++, arg), arg, approvalDelayMs, 0, 3_600_000);
    else if (arg === "--oci-process-timeout-ms") ociMaxProcessRuntimeMs = integer(valueAfter(args, index++, arg), arg, ociMaxProcessRuntimeMs, 100, 3_600_000);
    else if (arg === "--oci-output-bytes") ociMaxProcessOutputBytes = integer(valueAfter(args, index++, arg), arg, ociMaxProcessOutputBytes, 1_000, 10_000_000);
    else if (arg === "--oci-memory-mb") ociMaxMemoryMb = integer(valueAfter(args, index++, arg), arg, ociMaxMemoryMb, 64, 32_768);
    else if (arg === "--oci-pids") ociMaxPids = integer(valueAfter(args, index++, arg), arg, ociMaxPids, 8, 4_096);
    else if (arg === "--oci-cpus") ociMaxCpus = integer(valueAfter(args, index++, arg), arg, ociMaxCpus, 1, 128);
    else if (arg === "--oci-workspace-bytes") ociMaxWorkspaceBytes = integer(valueAfter(args, index++, arg), arg, ociMaxWorkspaceBytes, 1_000_000, 2_147_483_647);
    else if (arg === "--oci-file-write-bytes") ociMaxFileWriteBytes = integer(valueAfter(args, index++, arg), arg, ociMaxFileWriteBytes, 1_000, 1_000_000_000);
    else if (arg === "--oci-tmpfs-mb") ociTmpfsMb = integer(valueAfter(args, index++, arg), arg, ociTmpfsMb, 16, 32_768);
    else throw new Error(`Unknown driver argument: ${arg}.`);
  }
  const uniqueCommands = [...new Set(allowedCommands.length ? allowedCommands : ["node", "npm", "python3"] )];
  if (uniqueCommands.some((command) => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(command))) {
    throw new Error("--allowed-command values must be bounded executable names, not paths or shell expressions.");
  }
  return {
    provider: parseProvider(providerValue),
    ...(model ? { model } : {}),
    ociRuntime,
    ...(ociImage ? { ociImage } : {}),
    allowedCommands: uniqueCommands,
    ...(verifierCommand ? { verifierCommand } : {}),
    verifierArgs,
    maxSteps,
    maxToolCalls,
    maxTokens,
    timeoutMs,
    approvalDelayMs,
    ociMaxProcessRuntimeMs,
    ociMaxProcessOutputBytes,
    ociMaxMemoryMb,
    ociMaxPids,
    ociMaxCpus,
    ociMaxWorkspaceBytes,
    ociMaxFileWriteBytes,
    ociTmpfsMb
  };
};

const targetTest = (request: TimeToSafeFixDriverRequest) =>
  request.task.target_test_node.split("::")[0]?.replaceAll("\\", "/") ?? request.task.target_test_node;

const verifierFor = (options: DriverOptions, request: TimeToSafeFixDriverRequest): TimeToSafeFixVerifierCommand => {
  const target = request.task.target_test_node;
  const targetFile = targetTest(request);
  if (options.verifierCommand) {
    return {
      command: options.verifierCommand,
      args: options.verifierArgs.map((arg) => arg.replaceAll("{target}", target).replaceAll("{targetFile}", targetFile))
    };
  }
  if (targetFile.endsWith(".py")) {
    const command = options.allowedCommands.includes("python")
      ? "python"
      : options.allowedCommands.includes("python3")
        ? "python3"
        : undefined;
    if (!command) throw new Error("Python verifier requires --allowed-command python or python3.");
    return { command, args: ["-B", "-m", "pytest", "-p", "no:cacheprovider", target] };
  }
  if (options.allowedCommands.includes("bun")) return { command: "bun", args: ["test", targetFile] };
  if (options.allowedCommands.includes("node")) return { command: "node", args: ["--test", targetFile] };
  throw new Error("Unable to derive a verifier; provide --verifier-command and --verifier-arg values.");
};

const driverConfigInput = (options: DriverOptions, workspace: string) => ({
  provider: options.provider,
  ...(options.model ? { model: options.model } : {}),
  workspace,
  executionBackend: "oci" as const,
  ociRuntime: options.ociRuntime,
  ...(options.ociImage ? { ociImage: options.ociImage } : {}),
  ociAllowedCommands: options.allowedCommands,
  ociMaxProcessRuntimeMs: options.ociMaxProcessRuntimeMs,
  ociMaxProcessOutputBytes: options.ociMaxProcessOutputBytes,
  ociMaxMemoryMb: options.ociMaxMemoryMb,
  ociMaxPids: options.ociMaxPids,
  ociMaxCpus: options.ociMaxCpus,
  ociMaxWorkspaceBytes: options.ociMaxWorkspaceBytes,
  ociMaxFileWriteBytes: options.ociMaxFileWriteBytes,
  ociTmpfsMb: options.ociTmpfsMb,
  maxSteps: options.maxSteps,
  maxToolCalls: options.maxToolCalls,
  maxOutputTokens: options.maxTokens,
  timeoutMs: options.timeoutMs,
  subagentProfiles: []
});

export const runZhivexTimeToSafeFixDriver = async (
  request: TimeToSafeFixDriverRequest,
  options: DriverOptions,
  env: NodeJS.ProcessEnv = process.env
) => {
  const cwd = await realpath(process.cwd());
  const workspace = await realpath(request.workspace);
  if (cwd !== workspace) throw new Error("Driver request workspace must match the child process working directory.");
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-safe-fix-entry-state-"));
  try {
    const resolved = resolveHarnessConfig(driverConfigInput(options, workspace));
    if (resolved.execution.backend !== "oci") throw new Error("Driver requires enforced OCI execution.");
    const model = createProviderModel(resolved, env);
    const verifierCommand = (candidate: TimeToSafeFixDriverRequest) => verifierFor(options, candidate);
    if (request.profile === "direct") {
      return await runDirectProfile(request, {
        model,
        execution: resolved.execution as Extract<HarnessExecutionConfig, { backend: "oci" }>,
        stateDirectory,
        verifierCommand,
        maxSteps: options.maxSteps,
        maxToolCalls: options.maxToolCalls,
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs
      });
    }
    return await runGovernedTimeToSafeFixProfile(request, {
      provider: options.provider,
      ...(options.model ? { model: options.model } : {}),
      modelInstance: model,
      env,
      stateDirectory,
      verifierCommand,
      allowedCommands: options.allowedCommands,
      ...(options.ociImage ? { ociImage: options.ociImage } : {}),
      maxSteps: options.maxSteps,
      maxToolCalls: options.maxToolCalls,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      approvalDelayMs: options.approvalDelayMs,
      ociMaxProcessRuntimeMs: options.ociMaxProcessRuntimeMs,
      ociMaxProcessOutputBytes: options.ociMaxProcessOutputBytes,
      ociMaxMemoryMb: options.ociMaxMemoryMb,
      ociMaxPids: options.ociMaxPids,
      ociMaxCpus: options.ociMaxCpus,
      ociMaxWorkspaceBytes: options.ociMaxWorkspaceBytes,
      ociMaxFileWriteBytes: options.ociMaxFileWriteBytes,
      ociTmpfsMb: options.ociTmpfsMb
    });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseZhivexDriverOptions(process.argv.slice(2));
  const request = await readTimeToSafeFixDriverRequest();
  const result = await runZhivexTimeToSafeFixDriver(request, options);
  process.stdout.write(renderTimeToSafeFixDriverResult(result));
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`[time-to-safe-fix-driver] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
