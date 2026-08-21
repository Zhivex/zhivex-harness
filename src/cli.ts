#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  getAgentBudgetStatus,
  type AgentApprovalRequest,
  type AgentApprovalResponse,
  type AgentRunInput,
  type AgentRunOutput,
  type AgentRunState,
  type AgentStatus,
  type AgentStreamEvent
} from "@zhivex-ai/agents";

import {
  DEFAULT_PROVIDER_REGISTRY,
  HARNESS_REQUIRED_CAPABILITIES,
  HARNESS_SUBAGENT_PROFILES,
  PROVIDERS,
  parseProvider,
  providerAvailability,
  resolveHarnessConfig,
  type HarnessConfig,
  type HarnessConfigInput,
  type HarnessProvider,
  type HarnessSubagentProfile
} from "./config.js";
import {
  appendUserMessage,
  compactHarnessMessages,
  createHarness,
  runHarness,
  type HarnessRunOptions,
  type ZhivexHarness
} from "./harness.js";
import {
  estimateAgentRunCost,
  type AgentTelemetryObserver,
  type TokenPricing
} from "@zhivex-ai/agents/ops";
import {
  cancelHarnessRun,
  cleanupHarnessRuns,
  inspectHarnessRun,
  listHarnessRuns,
  openHarnessPersistence
} from "./operations.js";
import { validateStateDirectory } from "./state-directory.js";
import { loadHarnessMcpConfiguration } from "./mcp.js";
import { runHarnessReviewGroup } from "./orchestration.js";
import { BUN_ENGINE_RANGE, HARNESS_VERSION } from "./version.js";
import {
  CliOciRuntimeAdapter,
  cleanupHarnessExecutionArtifacts,
  type HarnessOciRuntimeAdapter
} from "./execution-environment.js";
import {
  createHarnessRouteModels,
  parseHarnessModelRoute,
  resolveHarnessModelRoutes,
  serializeHarnessModelRoutes,
  type HarnessModelRoute
} from "./routing.js";
import {
  CLI_JSON_SCHEMA_VERSION,
  serializeStreamEvent,
  serializeStreamResult
} from "./cli-stream.js";
import {
  openCliSessionStore,
  type CliSession,
  type SessionRunStatus
} from "./sessions.js";
import {
  canonicalizeChangeEnvelope,
  changeEnvelopePreconditionsSchema,
  createChangeEnvelope,
  digestChangeEnvelopeArtifact,
  verifyChangeEnvelope,
  type ChangeEnvelopePreconditions
} from "./change-envelope.js";

export { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
export const HARNESS_RESUME_METADATA_KEY = "zhivexHarnessResume" as const;
export const HARNESS_RESUME_METADATA_SCHEMA_VERSION = 1 as const;

export const CLI_EXIT_CODES = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
  doctorFailed: 3
} as const;

type Command = "run" | "review" | "chat" | "providers" | "doctor" | "resume" | "runs" | "sessions" | "changes" | "help" | "version";
type RunsCommand = "list" | "inspect" | "cancel" | "cleanup" | "export";
type SessionsCommand = "list" | "inspect" | "rename" | "fork" | "archive";
type ChangesCommand = "create" | "verify";

export interface CliOptions {
  command: Command;
  provider?: string;
  model?: string;
  workspace?: string;
  stateDirectory?: string;
  storeBackend?: string;
  tenantId?: string;
  userId?: string;
  namespace?: string;
  maxSteps?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxToolErrors?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  allowedChecks?: string[];
  requiredCapabilities?: string[];
  subagentProfiles?: HarnessSubagentProfile[];
  reviewers?: HarnessSubagentProfile[];
  routes?: string[];
  subagentMaxSteps?: number;
  subagentMaxToolCalls?: number;
  subagentMaxToolErrors?: number;
  subagentMaxInputTokens?: number;
  subagentMaxOutputTokens?: number;
  subagentMaxTotalTokens?: number;
  subagentTimeoutMs?: number;
  maxParallelReviews?: number;
  executionBackend?: string;
  ociRuntime?: string;
  ociImage?: string;
  ociAllowedCommands?: string[];
  ociMaxProcessRuntimeMs?: number;
  ociMaxProcessOutputBytes?: number;
  ociMaxMemoryMb?: number;
  ociMaxPids?: number;
  ociMaxCpus?: number;
  ociMaxWorkspaceBytes?: number;
  ociMaxFileWriteBytes?: number;
  ociTmpfsMb?: number;
  mcpConfigPath?: string;
  prompt?: string;
  runId?: string;
  idempotencyKey?: string;
  runsCommand?: RunsCommand;
  sessionsCommand?: SessionsCommand;
  changesCommand?: ChangesCommand;
  artifactPath?: string;
  patchPath?: string;
  preconditionsPath?: string;
  verificationTime?: string;
  sessionId?: string;
  sessionTitle?: string;
  continueSession: boolean;
  implicitCommand: boolean;
  statuses?: AgentStatus[];
  limit?: number;
  cursor?: string;
  before?: number;
  reason?: string;
  cascade: boolean;
  final: boolean;
  yes: boolean;
  approve?: boolean;
  json: boolean;
  jsonl: boolean;
}

const COMMANDS = new Set<Command>(["run", "review", "chat", "providers", "doctor", "resume", "runs", "sessions", "changes", "help", "version"]);
const RUNS_COMMANDS = new Set<RunsCommand>(["list", "inspect", "cancel", "cleanup", "export"]);
const SESSIONS_COMMANDS = new Set<SessionsCommand>(["list", "inspect", "rename", "fork", "archive"]);
const CHANGES_COMMANDS = new Set<ChangesCommand>(["create", "verify"]);
const CLI_TIMESTAMP_SCHEMA = z.iso.datetime({ precision: 3 });
const RUN_STATUSES = new Set<AgentStatus>([
  "queued",
  "running",
  "completed",
  "suspended",
  "waiting_approval",
  "cancel_requested",
  "failed",
  "cancelled",
  "timed_out"
]);

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const harnessConfigInput = (config: HarnessConfig): HarnessConfigInput => ({
  schemaVersion: config.schemaVersion,
  provider: config.provider,
  model: config.model,
  workspace: config.workspace,
  stateDirectory: config.stateDirectory,
  storeBackend: config.storeBackend,
  tenantId: config.scope.tenantId,
  ...(config.scope.userId ? { userId: config.scope.userId } : {}),
  ...(config.scope.namespace ? { namespace: config.scope.namespace } : {}),
  maxSteps: config.maxSteps,
  timeoutMs: config.timeoutMs,
  maxToolCalls: config.budget.maxToolCalls,
  maxToolErrors: config.budget.maxToolErrors,
  maxInputTokens: config.budget.maxInputTokens,
  maxOutputTokens: config.budget.maxOutputTokens,
  maxTotalTokens: config.budget.maxTotalTokens,
  ...(config.costBudget
    ? {
        maxCostUsd: config.costBudget.maxCostUsd,
        inputCostPerMillion: config.costBudget.inputCostPer1kTokens * 1_000,
        outputCostPerMillion: config.costBudget.outputCostPer1kTokens * 1_000
      }
    : {}),
  compactionMaxMessages: config.compaction.maxMessages,
  compactionMaxEstimatedInputTokens: config.compaction.maxEstimatedInputTokens,
  compactionKeepRecentMessages: config.compaction.keepRecentMessages,
  allowedChecks: [...config.allowedChecks],
  requiredCapabilities: [...config.requiredCapabilities],
  subagentProfiles: [...config.orchestration.profiles],
  subagentMaxSteps: config.orchestration.childBudget.maxSteps,
  subagentMaxToolCalls: config.orchestration.childBudget.maxToolCalls,
  subagentMaxToolErrors: config.orchestration.childBudget.maxToolErrors,
  subagentMaxInputTokens: config.orchestration.childBudget.maxInputTokens,
  subagentMaxOutputTokens: config.orchestration.childBudget.maxOutputTokens,
  subagentMaxTotalTokens: config.orchestration.childBudget.maxTotalTokens,
  subagentTimeoutMs: config.orchestration.childTimeoutMs,
  maxParallelReviews: config.orchestration.maxParallelReviews,
  executionBackend: config.execution.backend,
  ...(config.execution.backend === "oci"
    ? {
        ociRuntime: config.execution.runtime,
        ociImage: config.execution.image,
        ociAllowedCommands: [...config.execution.allowedCommands],
        ociMaxProcessRuntimeMs: config.execution.maxProcessRuntimeMs,
        ociMaxProcessOutputBytes: config.execution.maxProcessOutputBytes,
        ociMaxMemoryMb: config.execution.maxMemoryMb,
        ociMaxPids: config.execution.maxPids,
        ociMaxCpus: config.execution.maxCpus,
        ociMaxWorkspaceBytes: config.execution.maxWorkspaceBytes,
        ociMaxFileWriteBytes: config.execution.maxFileWriteBytes,
        ociTmpfsMb: config.execution.tmpfsMb
      }
    : {}),
  ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {})
});

export const createHarnessResumeMetadata = (
  config: HarnessConfig,
  routes?: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>
): NonNullable<AgentRunInput["metadata"]> => ({
  [HARNESS_RESUME_METADATA_KEY]: JSON.parse(JSON.stringify({
    schemaVersion: HARNESS_RESUME_METADATA_SCHEMA_VERSION,
    config,
    ...(routes && routes.size > 0 ? { routes: serializeHarnessModelRoutes(routes) } : {})
  }))
});

const readHarnessResumeDocument = (state: Pick<AgentRunState, "metadata">) => {
  const value = state.metadata?.[HARNESS_RESUME_METADATA_KEY];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted harness resume metadata is invalid.");
  }
  const document = value as { schemaVersion?: unknown; config?: unknown; routes?: unknown };
  if (
    document.schemaVersion !== HARNESS_RESUME_METADATA_SCHEMA_VERSION ||
    !document.config ||
    typeof document.config !== "object" ||
    Array.isArray(document.config)
  ) {
    throw new Error("Persisted harness resume metadata is invalid.");
  }
  return document;
};

export const readHarnessResumeConfig = (
  state: Pick<AgentRunState, "metadata">
): HarnessConfigInput | undefined => {
  const document = readHarnessResumeDocument(state);
  if (!document) return undefined;
  try {
    return harnessConfigInput(document.config as HarnessConfig);
  } catch {
    throw new Error("Persisted harness resume metadata is invalid.");
  }
};

export const readHarnessResumeRoutes = (
  state: Pick<AgentRunState, "metadata">
) => {
  const document = readHarnessResumeDocument(state);
  if (!document?.routes) return resolveHarnessModelRoutes();
  if (typeof document.routes !== "object" || Array.isArray(document.routes)) {
    throw new Error("Persisted harness routing metadata is invalid.");
  }
  try {
    const values = Object.entries(document.routes as Record<string, unknown>).map(([profile, target]) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("invalid");
      const route = target as { provider?: unknown; model?: unknown };
      if (typeof route.provider !== "string" || typeof route.model !== "string") throw new Error("invalid");
      return `${profile}=${route.provider}:${route.model}`;
    });
    return resolveHarnessModelRoutes(values);
  } catch {
    throw new Error("Persisted harness routing metadata is invalid.");
  }
};

const shellArgument = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const resumeCommand = (runId: string, config: HarnessConfig, approve = true) => [
  "zhivex-harness",
  "resume",
  shellArgument(runId),
  approve ? "--approve" : "--deny",
  "--workspace",
  shellArgument(config.workspace),
  "--state-dir",
  shellArgument(config.stateDirectory),
  "--store",
  config.storeBackend,
  "--tenant",
  shellArgument(config.scope.tenantId),
  ...(config.scope.userId ? ["--user", shellArgument(config.scope.userId)] : []),
  ...(config.scope.namespace ? ["--namespace", shellArgument(config.scope.namespace)] : [])
].join(" ");

const optionValue = (argv: string[], index: number, name: string) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${name}.`);
  }
  return value;
};

export const parseCliArgs = (argv: string[]): CliOptions => {
  let command: Command = "run";
  let commandWasExplicit = false;
  const positional: string[] = [];
  const options: CliOptions = {
    command,
    cascade: false,
    final: false,
    yes: false,
    json: false,
    jsonl: false,
    continueSession: false,
    implicitCommand: true
  };
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) {
      continue;
    }
    if (positionalOnly) {
      positional.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!commandWasExplicit && COMMANDS.has(argument as Command)) {
      command = argument as Command;
      options.command = command;
      commandWasExplicit = true;
      continue;
    }

    switch (argument) {
      case "--provider":
        try {
          options.provider = parseProvider(optionValue(argv, index, argument));
        } catch (error) {
          throw new CliUsageError(error instanceof Error ? error.message : String(error));
        }
        index += 1;
        break;
      case "--model":
        options.model = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--route": {
        const value = optionValue(argv, index, argument);
        try {
          parseHarnessModelRoute(value);
        } catch (error) {
          throw new CliUsageError(error instanceof Error ? error.message : String(error));
        }
        options.routes ??= [];
        options.routes.push(value);
        if (options.routes.length > HARNESS_SUBAGENT_PROFILES.length) {
          throw new CliUsageError(`--route cannot be repeated more than ${HARNESS_SUBAGENT_PROFILES.length} times.`);
        }
        index += 1;
        break;
      }
      case "--workspace":
        options.workspace = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--state-dir":
        options.stateDirectory = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--mcp-config":
        options.mcpConfigPath = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--patch":
        options.patchPath = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--preconditions":
        options.preconditionsPath = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--now": {
        const value = optionValue(argv, index, argument);
        if (!CLI_TIMESTAMP_SCHEMA.safeParse(value).success) {
          throw new CliUsageError("--now must be a millisecond-precision ISO-8601 UTC timestamp.");
        }
        options.verificationTime = value;
        index += 1;
        break;
      }
      case "--execution":
        options.executionBackend = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--oci-runtime":
        options.ociRuntime = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--oci-image":
        options.ociImage = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--oci-allow-command": {
        const value = optionValue(argv, index, argument);
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)) {
          throw new CliUsageError("--oci-allow-command requires a bare executable name.");
        }
        options.ociAllowedCommands ??= [];
        options.ociAllowedCommands.push(value);
        index += 1;
        break;
      }
      case "--store":
        options.storeBackend = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--tenant":
        options.tenantId = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--user":
        options.userId = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--namespace":
        options.namespace = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--idempotency-key":
        options.idempotencyKey = optionValue(argv, index, argument);
        if (options.idempotencyKey.length > 256) {
          throw new CliUsageError("--idempotency-key cannot exceed 256 characters.");
        }
        index += 1;
        break;
      case "--max-steps": {
        const value = optionValue(argv, index, argument);
        options.maxSteps = Number(value);
        if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 50) {
          throw new CliUsageError("--max-steps must be an integer between 1 and 50.");
        }
        index += 1;
        break;
      }
      case "--timeout-ms":
      case "--max-tool-calls":
      case "--max-tool-errors":
      case "--max-input-tokens":
      case "--max-output-tokens":
      case "--max-total-tokens":
      case "--subagent-max-steps":
      case "--subagent-max-tool-calls":
      case "--subagent-max-tool-errors":
      case "--subagent-max-input-tokens":
      case "--subagent-max-output-tokens":
      case "--subagent-max-total-tokens":
      case "--subagent-timeout-ms":
      case "--max-parallel-reviews": {
        const value = Number(optionValue(argv, index, argument));
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new CliUsageError(`${argument} must be a non-negative integer.`);
        }
        if (argument === "--timeout-ms") options.timeoutMs = value;
        if (argument === "--max-tool-calls") options.maxToolCalls = value;
        if (argument === "--max-tool-errors") options.maxToolErrors = value;
        if (argument === "--max-input-tokens") options.maxInputTokens = value;
        if (argument === "--max-output-tokens") options.maxOutputTokens = value;
        if (argument === "--max-total-tokens") options.maxTotalTokens = value;
        if (argument === "--subagent-max-steps") options.subagentMaxSteps = value;
        if (argument === "--subagent-max-tool-calls") options.subagentMaxToolCalls = value;
        if (argument === "--subagent-max-tool-errors") options.subagentMaxToolErrors = value;
        if (argument === "--subagent-max-input-tokens") options.subagentMaxInputTokens = value;
        if (argument === "--subagent-max-output-tokens") options.subagentMaxOutputTokens = value;
        if (argument === "--subagent-max-total-tokens") options.subagentMaxTotalTokens = value;
        if (argument === "--subagent-timeout-ms") options.subagentTimeoutMs = value;
        if (argument === "--max-parallel-reviews") options.maxParallelReviews = value;
        index += 1;
        break;
      }
      case "--oci-max-process-runtime-ms":
      case "--oci-max-process-output-bytes":
      case "--oci-max-memory-mb":
      case "--oci-max-pids":
      case "--oci-max-cpus":
      case "--oci-max-workspace-bytes":
      case "--oci-max-file-write-bytes":
      case "--oci-tmpfs-mb": {
        const value = Number(optionValue(argv, index, argument));
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new CliUsageError(`${argument} must be a positive integer.`);
        }
        if (argument === "--oci-max-process-runtime-ms") options.ociMaxProcessRuntimeMs = value;
        if (argument === "--oci-max-process-output-bytes") options.ociMaxProcessOutputBytes = value;
        if (argument === "--oci-max-memory-mb") options.ociMaxMemoryMb = value;
        if (argument === "--oci-max-pids") options.ociMaxPids = value;
        if (argument === "--oci-max-cpus") options.ociMaxCpus = value;
        if (argument === "--oci-max-workspace-bytes") options.ociMaxWorkspaceBytes = value;
        if (argument === "--oci-max-file-write-bytes") options.ociMaxFileWriteBytes = value;
        if (argument === "--oci-tmpfs-mb") options.ociTmpfsMb = value;
        index += 1;
        break;
      }
      case "--max-cost-usd":
      case "--input-cost-per-million":
      case "--output-cost-per-million": {
        const value = Number(optionValue(argv, index, argument));
        if (!Number.isFinite(value) || value < 0) {
          throw new CliUsageError(`${argument} must be a non-negative number.`);
        }
        if (argument === "--max-cost-usd") options.maxCostUsd = value;
        if (argument === "--input-cost-per-million") options.inputCostPerMillion = value;
        if (argument === "--output-cost-per-million") options.outputCostPerMillion = value;
        index += 1;
        break;
      }
      case "--allow-check": {
        const value = optionValue(argv, index, argument);
        if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(value)) {
          throw new CliUsageError(
            "--allow-check must use 1-64 letters, digits, colon, underscore, or hyphen."
          );
        }
        options.allowedChecks ??= [];
        options.allowedChecks.push(value);
        if (options.allowedChecks.length > 50) {
          throw new CliUsageError("--allow-check cannot be repeated more than 50 times.");
        }
        index += 1;
        break;
      }
      case "--require-capability": {
        const value = optionValue(argv, index, argument);
        if (!(HARNESS_REQUIRED_CAPABILITIES as readonly string[]).includes(value)) {
          throw new CliUsageError(
            `--require-capability must be one of: ${HARNESS_REQUIRED_CAPABILITIES.join(", ")}.`
          );
        }
        options.requiredCapabilities ??= [];
        options.requiredCapabilities.push(value);
        index += 1;
        break;
      }
      case "--subagent": {
        const value = optionValue(argv, index, argument);
        if (!(HARNESS_SUBAGENT_PROFILES as readonly string[]).includes(value)) {
          throw new CliUsageError(`--subagent must be one of: ${HARNESS_SUBAGENT_PROFILES.join(", ")}.`);
        }
        options.subagentProfiles ??= [];
        options.subagentProfiles.push(value as HarnessSubagentProfile);
        index += 1;
        break;
      }
      case "--reviewer": {
        const value = optionValue(argv, index, argument) as HarnessSubagentProfile;
        if (value !== "explorer" && value !== "reviewer") {
          throw new CliUsageError("--reviewer must be explorer or reviewer.");
        }
        options.reviewers ??= [];
        options.reviewers.push(value);
        index += 1;
        break;
      }
      case "--yes":
        options.yes = true;
        break;
      case "--approve":
        if (options.approve === false) {
          throw new CliUsageError("You cannot combine --approve and --deny.");
        }
        options.approve = true;
        break;
      case "--deny":
        if (options.approve === true) {
          throw new CliUsageError("You cannot combine --approve and --deny.");
        }
        options.approve = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--jsonl":
        options.jsonl = true;
        break;
      case "--session":
        options.sessionId = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--continue":
        options.continueSession = true;
        break;
      case "--status": {
        const value = optionValue(argv, index, argument) as AgentStatus;
        if (!RUN_STATUSES.has(value)) {
          throw new CliUsageError(`Unsupported run status: ${value}.`);
        }
        options.statuses ??= [];
        options.statuses.push(value);
        index += 1;
        break;
      }
      case "--limit": {
        const value = Number(optionValue(argv, index, argument));
        if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
          throw new CliUsageError("--limit must be an integer between 1 and 1000.");
        }
        options.limit = value;
        index += 1;
        break;
      }
      case "--cursor":
        options.cursor = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--before": {
        const value = optionValue(argv, index, argument);
        const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          throw new CliUsageError("--before must be an ISO-8601 date or millisecond timestamp.");
        }
        options.before = timestamp;
        index += 1;
        break;
      }
      case "--reason":
        options.reason = optionValue(argv, index, argument);
        if (options.reason.length > 500) {
          throw new CliUsageError("--reason cannot exceed 500 characters.");
        }
        index += 1;
        break;
      case "--cascade":
        options.cascade = true;
        break;
      case "--final":
        options.final = true;
        break;
      case "--help":
      case "-h":
        options.command = "help";
        break;
      case "--version":
      case "-v":
        options.command = "version";
        break;
      default:
        if (argument.startsWith("-")) {
          throw new CliUsageError(`Unknown option: ${argument}`);
        }
        positional.push(argument);
    }
  }

  options.implicitCommand = !commandWasExplicit;
  if (options.json && options.jsonl) {
    throw new CliUsageError("You cannot combine --json and --jsonl.");
  }
  if (options.sessionId && options.continueSession) {
    throw new CliUsageError("You cannot combine --session and --continue.");
  }
  if (options.jsonl && options.command !== "run" && options.command !== "resume") {
    throw new CliUsageError("--jsonl is supported by run and resume.");
  }
  if (options.command !== "changes" && (options.patchPath || options.preconditionsPath || options.verificationTime)) {
    throw new CliUsageError("--patch, --preconditions, and --now are supported only by changes.");
  }

  if (options.command === "resume") {
    const runId = positional.shift();
    if (runId) {
      options.runId = runId;
    }
    if (positional.length > 0) {
      throw new CliUsageError("resume accepts exactly one runId.");
    }
  } else if (options.command === "runs") {
    const runsCommand = positional.shift() as RunsCommand | undefined;
    if (!runsCommand || !RUNS_COMMANDS.has(runsCommand)) {
      throw new CliUsageError("runs requires one of: list, inspect, cancel, cleanup, export.");
    }
    options.runsCommand = runsCommand;
    if (runsCommand === "inspect" || runsCommand === "cancel" || runsCommand === "export") {
      const runId = positional.shift();
      if (!runId) {
        throw new CliUsageError(`runs ${runsCommand} requires a runId.`);
      }
      options.runId = runId;
    }
    if (runsCommand === "cleanup" && options.before === undefined) {
      throw new CliUsageError("runs cleanup requires --before.");
    }
    if (positional.length > 0) {
      throw new CliUsageError(`runs ${runsCommand} received unexpected positional arguments.`);
    }
  } else if (options.command === "sessions") {
    const sessionsCommand = positional.shift() as SessionsCommand | undefined;
    if (!sessionsCommand || !SESSIONS_COMMANDS.has(sessionsCommand)) {
      throw new CliUsageError("sessions requires one of: list, inspect, rename, fork, archive.");
    }
    options.sessionsCommand = sessionsCommand;
    if (sessionsCommand !== "list") {
      const sessionId = positional.shift();
      if (!sessionId) throw new CliUsageError(`sessions ${sessionsCommand} requires a sessionId.`);
      options.sessionId = sessionId;
    }
    if (sessionsCommand === "rename") {
      const title = positional.join(" ").trim();
      if (!title) throw new CliUsageError("sessions rename requires a title.");
      options.sessionTitle = title;
      positional.length = 0;
    }
    if (positional.length > 0) {
      throw new CliUsageError(`sessions ${sessionsCommand} received unexpected positional arguments.`);
    }
  } else if (options.command === "changes") {
    const changesCommand = positional.shift() as ChangesCommand | undefined;
    if (!changesCommand || !CHANGES_COMMANDS.has(changesCommand)) {
      throw new CliUsageError("changes requires one of: create, verify.");
    }
    options.changesCommand = changesCommand;
    const artifactPath = positional.shift();
    if (!artifactPath) {
      throw new CliUsageError(`changes ${changesCommand} requires an input JSON file.`);
    }
    options.artifactPath = artifactPath;
    if (!options.patchPath) {
      throw new CliUsageError(`changes ${changesCommand} requires --patch <file>.`);
    }
    if (changesCommand === "create" && (options.preconditionsPath || options.verificationTime)) {
      throw new CliUsageError("--preconditions and --now are only supported by changes verify.");
    }
    if (positional.length > 0) {
      throw new CliUsageError(`changes ${changesCommand} received unexpected positional arguments.`);
    }
  } else if (options.command === "run" || options.command === "review") {
    const prompt = positional.join(" ").trim();
    if (prompt) {
      options.prompt = prompt;
    }
  } else if (positional.length > 0) {
    throw new CliUsageError(`${options.command} does not accept positional arguments.`);
  }

  return options;
};

const help = `Zhivex Harness v${HARNESS_VERSION}

Usage:
  zhx                              Start the interactive console
  zhx run [options] "task"
  zhx review [options] "review task"
  zhx chat [options] [--continue|--session <id>]
  zhx providers [--json]
  zhx doctor [options] [--json]
  zhx resume [options] <runId> --approve|--deny
  zhx runs list [--status <status>] [--limit <n>] [--json]
  zhx sessions list|inspect|rename|fork|archive
  zhx changes create <input.json> --patch <artifact>
  zhx changes verify <envelope.json> --patch <artifact> [--preconditions <file>]

The long command zhivex-harness remains supported for compatibility.

Options:
  --provider <${PROVIDERS.join("|")}>  Provider (default: openai)
  --model <id>                   Override the default model
  --route <role=provider[:model]> Route a subagent role; repeatable
  --session <id>                 Open a durable interactive session
  --continue                     Open the latest durable interactive session
  --workspace <path>             Target workspace (default: cwd)
  --state-dir <path>             Durable run-state directory
  --mcp-config <path>            Declarative governed MCP JSON configuration
  --patch <path>                 Exact patch/artifact bytes bound to a change envelope
  --preconditions <path>         Verification preconditions JSON for changes verify
  --now <ISO-8601 UTC>           Explicit millisecond verification time (default: current time)
  --execution <none|oci>         Enforced execution backend (default: none)
  --oci-runtime <docker|podman>  Local OCI runtime (default: docker)
  --oci-image <reference>        Preloaded immutable-capable OCI image
  --oci-allow-command <name>     Allow one argv executable in OCI; repeatable, must include bun
  --oci-max-process-runtime-ms <n> Per-command timeout (default: 120000)
  --oci-max-process-output-bytes <n> Combined output ceiling (default: 20000)
  --oci-max-memory-mb <n>        Container memory ceiling (default: 1024)
  --oci-max-pids <n>             Container process ceiling (default: 128)
  --oci-max-cpus <n>             Container CPU ceiling (default: 2)
  --oci-max-workspace-bytes <n>  Snapshot size ceiling (default: 67108864)
  --oci-max-file-write-bytes <n> Patch file ceiling (default: 1048576)
  --oci-tmpfs-mb <n>            Writable /tmp ceiling (default: 256)
  --store <sqlite|file>          Durable backend (default: sqlite)
  --tenant <id>                  Durable tenant scope (default: local)
  --user <id>                    Optional durable user scope
  --namespace <id>               Optional scope namespace (default: workspace digest)
  --idempotency-key <key>        Reuse the same durable run for duplicate requests
  --max-steps <1-50>             Maximum agent steps (default: 12)
  --max-tool-calls <n>           Maximum tool calls (default: 32)
  --max-tool-errors <n>          Maximum failed tool calls (default: 4)
  --max-input-tokens <n>         Maximum measured input tokens (default: 100000)
  --max-output-tokens <n>        Maximum measured output tokens (default: 30000)
  --max-total-tokens <n>         Maximum total tokens (default: 120000)
  --max-cost-usd <amount>        Optional measured cost ceiling
  --input-cost-per-million <n>   Input-token pricing for the cost ceiling
  --output-cost-per-million <n>  Output-token pricing for the cost ceiling
  --timeout-ms <n>               Wall-clock timeout (default: 900000)
  --allow-check <script>         Allow one package.json script; repeatable
  --require-capability <name>    Reject incompatible models before a run; repeatable
  --subagent <profile>           Enable explorer, implementer, tester, or reviewer; repeatable
  --subagent-max-steps <n>       Independent child step budget (default: 8)
  --subagent-max-tool-calls <n>  Independent child tool budget (default: 16)
  --subagent-max-total-tokens <n> Independent child token budget (default: 36000)
  --subagent-timeout-ms <n>      Independent child timeout (default: 300000)
  --reviewer <profile>           Read-only review group member; repeatable
  --max-parallel-reviews <1-4>   Review group concurrency ceiling (default: 2)
  --yes                          Automatically approve writes and checks
  --json                         Emit structured final output
  --jsonl                        Stream redacted JSON Lines, then the final result
  -h, --help                     Show this help
  -v, --version                  Show the version

Exit codes:
  0  Success
  1  Run-time or agent failure
  2  Invalid CLI usage
  3  Doctor found a blocking local configuration problem

Credentials:
  OpenAI: OPENAI_API_KEY
  Meta:   MODEL_API_KEY
  Qwen:   DASHSCOPE_API_KEY or QWEN_API_KEY
  Gemini: GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY`;

export const summarizeApproval = (approval: AgentApprovalRequest) => {
  const mustShowCompleteProposal = approval.name === "apply_patch";
  const argumentsText = !mustShowCompleteProposal && approval.arguments.length > 1200
    ? `${approval.arguments.slice(0, 1200)}…`
    : approval.arguments;
  return `[${approval.kind ?? "provider"}] ${approval.name}\n${argumentsText}`;
};

const approvalResponses = (
  approvals: readonly AgentApprovalRequest[],
  approve: boolean,
  reason: string
): AgentApprovalResponse[] => approvals.map((approval) => ({
  provider: approval.provider,
  approvalRequestId: approval.id,
  approve,
  reason
}));

const terminalApprovalResolver = (
  automaticallyApprove: boolean,
  ask?: (question: string) => Promise<string>
): NonNullable<HarnessRunOptions["resolveApprovals"]> => async (approvals) => {
  if (automaticallyApprove) {
    return approvalResponses(approvals, true, "Approved by --yes.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const readline = ask ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const question = ask ?? ((text: string) => readline!.question(text));
  try {
    const responses: AgentApprovalResponse[] = [];
    for (const approval of approvals) {
      process.stderr.write(`\nApproval required:\n${summarizeApproval(approval)}\n`);
      const answer = (await question("Approve? [y/N] ")).trim().toLowerCase();
      const approve = answer === "y" || answer === "yes";
      responses.push({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve,
        reason: approve ? "Approved interactively." : "Denied by the operator."
      });
    }
    return responses;
  } finally {
    readline?.close();
  }
};

const costPricing = (harness: ZhivexHarness): TokenPricing | undefined => harness.config.costBudget
  ? {
      inputCostPer1kTokens: harness.config.costBudget.inputCostPer1kTokens,
      outputCostPer1kTokens: harness.config.costBudget.outputCostPer1kTokens,
      currency: "USD"
    }
  : undefined;

export const runResultDocument = (result: AgentRunOutput, harness: ZhivexHarness) => ({
  schemaVersion: CLI_JSON_SCHEMA_VERSION,
  kind: "run-result" as const,
  runId: result.state.runId,
  status: result.status,
  provider: result.state.provider,
  model: result.state.modelId,
  output: result.outputText,
  steps: result.steps.length,
  toolCalls: result.toolResults.length,
  mutations: harness.workspace.mutationAudit(),
  pendingApprovals: result.state.pendingApprovals.map((approval) => ({
    id: approval.id,
    kind: approval.kind ?? "provider",
    name: approval.name,
    arguments: approval.arguments,
    ...(approval.childRunId ? { childRunId: approval.childRunId } : {}),
    ...(approval.childAgentId ? { childAgentId: approval.childAgentId } : {})
  })),
  children: (result.state.childRuns ?? []).map((child) => ({
    runId: child.runId,
    agentId: child.agentId,
    toolName: child.toolName,
    status: child.status,
    steps: child.steps,
    toolCalls: child.toolCalls,
    toolErrors: child.toolErrors,
    usage: child.usage
  })),
  usage: result.usage,
  budget: getAgentBudgetStatus(result.state, harness.config.budget, result),
  ...(harness.config.costBudget
    ? {
        costBudget: {
          limitUsd: harness.config.costBudget.maxCostUsd,
          estimate: estimateAgentRunCost(result.state, costPricing(harness))
        }
      }
    : {}),
  scope: result.state.scope,
  capabilities: harness.capabilities,
  orchestration: {
    profiles: harness.config.orchestration.profiles,
    childBudget: harness.config.orchestration.childBudget,
    mcpServers: harness.mcpConfiguration.servers.map((server) => server.name)
  },
  execution: harness.executionEnvironment
    ? {
        backend: "oci" as const,
        binding: result.state.executionEnvironment,
        image: harness.executionEnvironment.image
      }
    : { backend: "none" as const },
  store: {
    backend: harness.config.storeBackend,
    stateDirectory: harness.config.stateDirectory,
    migration: harness.persistence?.migration
  },
  stateDirectory: harness.config.stateDirectory
});

const printTerminalResult = (
  result: AgentRunOutput,
  harness: ZhivexHarness,
  output: Pick<CliOptions, "json" | "jsonl">,
  tracker: { streamedText: boolean; sequence?: number }
) => {
  const document = runResultDocument(result, harness);
  if (output.jsonl) {
    tracker.sequence = (tracker.sequence ?? 0) + 1;
    process.stdout.write(`${serializeStreamResult(document, tracker.sequence)}\n`);
    return;
  }
  if (output.json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  if (!tracker.streamedText && result.outputText) {
    process.stdout.write(result.outputText);
  }
  if (result.outputText || tracker.streamedText) {
    process.stdout.write("\n");
  }
  process.stderr.write(
    `\nrun ${result.state.runId} · ${result.state.provider}/${result.state.modelId} · ${result.status} · ${result.steps.length} steps · ${harness.workspace.mutationAudit().length} mutations\n`
  );
  if (result.status === "waiting_approval") {
    for (const approval of result.state.pendingApprovals) {
      process.stderr.write(`\nPending approval:\n${summarizeApproval(approval)}\n`);
    }
    process.stderr.write(
      `The state was persisted. Resume with: ${resumeCommand(result.state.runId, harness.config)}\n`
    );
  }
};

const streamSink = (
  output: Pick<CliOptions, "json" | "jsonl">,
  tracker: { streamedText: boolean; sequence?: number }
) => async (event: AgentStreamEvent) => {
  if (output.jsonl) {
    tracker.sequence = (tracker.sequence ?? 0) + 1;
    process.stdout.write(`${serializeStreamEvent(event, tracker.sequence)}\n`);
    return;
  }
  if (!output.json && event.type === "text-delta") {
    tracker.streamedText = true;
    process.stdout.write(event.textDelta);
  }
};

const orchestrationObserver = (json: boolean): AgentTelemetryObserver => async (event) => {
  if (json) return;
  if (event.type === "subagent-start") {
    process.stderr.write(`\nsubagent start · ${event.childAgentId ?? event.toolName}\n`);
  } else if (event.type === "subagent-finish") {
    process.stderr.write(
      `\nsubagent finish · ${event.childRun.agentId ?? event.childRun.toolName} · ${event.childRun.status}\n`
    );
  }
};

const resolvedRouting = (options: CliOptions) => {
  return resolveHarnessModelRoutes(options.routes);
};

const assertRoutePricingIsSafe = (
  routes: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>,
  costBudget: HarnessConfig["costBudget"]
) => {
  if (routes.size > 0 && costBudget !== undefined) {
    throw new CliUsageError(
      "Cost budgets cannot be combined with model routes until pricing is configured per role."
    );
  }
};

export const withTemporaryHarnessProfiles = async <T>(
  profiles: readonly HarnessSubagentProfile[],
  configure: (profiles: readonly HarnessSubagentProfile[]) => Promise<void>,
  operation: () => Promise<T>
): Promise<T> => {
  await configure(profiles);
  try {
    return await operation();
  } finally {
    await configure([]);
  }
};

const createConfiguredHarness = async (
  options: CliOptions,
  extraProfiles: readonly HarnessSubagentProfile[] = [],
  persistedRoutes?: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>
) => {
  const routes = persistedRoutes ?? resolvedRouting(options);
  const resolvedConfig = resolveHarnessConfig(options);
  assertRoutePricingIsSafe(routes, resolvedConfig.costBudget);
  const profiles = [...new Set([
    ...(options.subagentProfiles ?? []),
    ...extraProfiles,
    ...routes.keys()
  ])];
  const quietTelemetry = options.json || options.jsonl;
  const harness = await createHarness({
    ...options,
    subagentProfiles: profiles,
    subagentModels: createHarnessRouteModels(routes),
    onTelemetryEvent: orchestrationObserver(quietTelemetry)
  });
  return { harness, routes };
};

const runOnce = async (options: CliOptions) => {
  if (!options.prompt) {
    throw new CliUsageError("Missing task. Example: zhivex-harness run \"fix the tests\".");
  }
  const { harness, routes } = await createConfiguredHarness(options);
  try {
    const tracker = { streamedText: false };
    const result = await runHarness(
      harness,
      {
        prompt: options.prompt,
        scope: harness.config.scope,
        metadata: createHarnessResumeMetadata(harness.config, routes),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
      },
      {
        onEvent: streamSink(options, tracker),
        resolveApprovals: terminalApprovalResolver(options.yes)
      }
    );
    printTerminalResult(result, harness, options, tracker);
    if (result.status === "failed" || result.status === "timed_out") {
      process.exitCode = CLI_EXIT_CODES.runtimeError;
    }
  } finally {
    harness.close();
  }
};

const reviewOnce = async (options: CliOptions) => {
  if (!options.prompt) {
    throw new CliUsageError("Missing review task. Example: zhivex-harness review \"review the state boundary\".");
  }
  const requestedReviewers: HarnessSubagentProfile[] = options.reviewers ?? ["explorer", "reviewer"];
  const enabledProfiles: HarnessSubagentProfile[] = [...new Set([
    ...(options.subagentProfiles ?? []),
    ...requestedReviewers
  ])];
  const { harness } = await createConfiguredHarness(options, enabledProfiles);
  try {
    const result = await runHarnessReviewGroup(
      harness,
      { prompt: options.prompt, scope: harness.config.scope },
      requestedReviewers
    );
    const document = {
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: "review-group" as const,
      groupId: result.groupId,
      status: result.status,
      profiles: result.profiles,
      outputs: result.outputs.map((member) => ({
        name: member.name,
        agentId: member.agentId,
        status: member.status,
        ...(member.output
          ? {
              runId: member.output.state.runId,
              runStatus: member.output.status,
              output: member.output.outputText,
              steps: member.output.steps.length,
              usage: member.output.usage
            }
          : {}),
        ...(member.error ? { error: member.error } : {})
      }))
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    } else {
      for (const output of document.outputs) {
        process.stdout.write(`\n[${output.name ?? output.agentId ?? "reviewer"}] ${output.status}\n`);
        if ("output" in output && output.output) process.stdout.write(`${output.output}\n`);
        if (output.error) process.stdout.write(`Error: ${output.error.message}\n`);
      }
    }
    if (result.status === "failed") {
      process.exitCode = CLI_EXIT_CODES.runtimeError;
    }
  } finally {
    harness.close();
  }
};

const resumeRun = async (options: CliOptions) => {
  if (!options.runId) {
    throw new CliUsageError("Missing runId to resume.");
  }
  if (options.approve === undefined) {
    throw new CliUsageError("Specify --approve or --deny when resuming.");
  }

  const initialConfig = resolveHarnessConfig(options);
  await validateStateDirectory(initialConfig.workspace, initialConfig.stateDirectory);
  const persistence = await openHarnessPersistence(initialConfig);
  try {
    const state = await persistence.store.load(options.runId, initialConfig.scope);
    if (!state) {
      throw new Error(`Run ${options.runId} was not found in ${initialConfig.stateDirectory}.`);
    }
    if (state.status !== "waiting_approval" || state.pendingApprovals.length === 0) {
      throw new Error(`Run ${options.runId} is not waiting for approval (status: ${state.status}).`);
    }

    for (const approval of state.pendingApprovals) {
      process.stderr.write(`\nResuming approval:\n${summarizeApproval(approval)}\n`);
    }

    const persistedResumeInput = readHarnessResumeConfig(state);
    const persistedRoutes = readHarnessResumeRoutes(state);
    let persistedResumeOptions: HarnessConfigInput = {};
    let resumeCostBudget = initialConfig.costBudget;
    if (persistedResumeInput) {
      const persistedConfig = resolveHarnessConfig(persistedResumeInput);
      if (
        persistedConfig.workspace !== initialConfig.workspace ||
        persistedConfig.stateDirectory !== initialConfig.stateDirectory ||
        persistedConfig.storeBackend !== initialConfig.storeBackend ||
        JSON.stringify(persistedConfig.scope) !== JSON.stringify(initialConfig.scope)
      ) {
        throw new Error(
          "Resume locator options do not match the persisted workspace, state directory, store, or scope."
        );
      }
      persistedResumeOptions = harnessConfigInput(persistedConfig);
      resumeCostBudget = persistedConfig.costBudget;
    }
    assertRoutePricingIsSafe(persistedRoutes, resumeCostBudget);

    const harness = await createHarness({
      ...persistedResumeOptions,
      ...options,
      provider: state.provider as HarnessProvider,
      model: state.modelId,
      subagentProfiles: [...new Set([
        ...((persistedResumeOptions.subagentProfiles ?? []) as HarnessSubagentProfile[]),
        ...persistedRoutes.keys()
      ])],
      subagentModels: createHarnessRouteModels(persistedRoutes),
      store: persistence.store,
      memory: persistence.memory,
      onTelemetryEvent: orchestrationObserver(options.json || options.jsonl)
    });
    const approve = options.approve;
    const tracker = { streamedText: false };
    const result = await runHarness(
      harness,
      {
        state,
        approvals: approvalResponses(
          state.pendingApprovals,
          approve,
          approve ? "Approved by resume --approve." : "Denied by resume --deny."
        )
      },
      {
        onEvent: streamSink(options, tracker),
        resolveApprovals: async (approvals) => approvalResponses(
          approvals,
          approve,
          approve ? "Approved by resume --approve." : "Denied by resume --deny."
        )
      }
    );
    await updateIndexedSessionRun(harness.config, result.state.runId, result.status);
    printTerminalResult(result, harness, options, tracker);
    if (result.status === "failed" || result.status === "timed_out") {
      process.exitCode = CLI_EXIT_CODES.runtimeError;
    }
  } finally {
    persistence.close();
  }
};

const chat = async (options: CliOptions) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Chat mode requires an interactive terminal. Use run for automation.");
  }
  const baseConfig = resolveHarnessConfig(options);
  const sessionStore = await openSessionStoreForConfig(baseConfig);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let runtimeOptions: CliOptions = { ...options };
  let routes = resolvedRouting(options);
  const selectedSession = options.sessionId
    ? await sessionStore.get(options.sessionId)
    : options.continueSession
      ? await sessionStore.latest()
      : undefined;
  if (options.sessionId && !selectedSession) {
    sessionStore.close();
    readline.close();
    throw new Error(`Session ${options.sessionId} was not found.`);
  }
  let session: CliSession = selectedSession ?? await sessionStore.create();
  let messages: AgentRunOutput["messages"] = [];

  const latestState = async (selected: CliSession) => {
    const latest = selected.runs.at(-1);
    if (!latest) return undefined;
    const persistence = await openHarnessPersistence(baseConfig);
    try {
      const state = await persistence.store.load(latest.runId, baseConfig.scope);
      if (!state) throw new Error(`Run ${latest.runId} referenced by session ${selected.sessionId} was not found.`);
      return state;
    } finally {
      persistence.close();
    }
  };

  let harness: ZhivexHarness;
  try {
    const restored = await latestState(session);
    if (restored) {
      runtimeOptions = { ...runtimeOptions, provider: restored.provider, model: restored.modelId };
      routes = readHarnessResumeRoutes(restored);
      messages = restored.messages;
    }
    harness = (await createConfiguredHarness(runtimeOptions, [], routes)).harness;
  } catch (error) {
    readline.close();
    sessionStore.close();
    throw error;
  }

  const refreshSession = async () => {
    const refreshed = await sessionStore.get(session.sessionId);
    if (!refreshed) throw new Error(`Session ${session.sessionId} was not found.`);
    session = refreshed;
    return session;
  };

  const hasActiveTurn = async () => {
    const latest = (await refreshSession()).runs.at(-1);
    return latest && !["completed", "failed", "cancelled", "timed_out"].includes(latest.status)
      ? latest
      : undefined;
  };

  const replaceHarness = async (
    nextOptions: CliOptions,
    nextRoutes: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>,
    extraProfiles: readonly HarnessSubagentProfile[] = []
  ) => {
    const created = await createConfiguredHarness(nextOptions, extraProfiles, nextRoutes);
    harness.close();
    harness = created.harness;
    runtimeOptions = nextOptions;
    routes = new Map(nextRoutes);
  };

  const withTemporaryProfiles = async <T>(
    profiles: readonly HarnessSubagentProfile[],
    operation: () => Promise<T>
  ) => {
    const normalOptions = runtimeOptions;
    const normalRoutes = new Map(routes);
    return withTemporaryHarnessProfiles(
      profiles,
      (temporaryProfiles) => replaceHarness(normalOptions, normalRoutes, temporaryProfiles),
      operation
    );
  };

  const restoreSession = async (selected: CliSession) => {
    const state = await latestState(selected);
    const nextOptions = state
      ? { ...runtimeOptions, provider: state.provider, model: state.modelId }
      : runtimeOptions;
    const nextRoutes = state ? readHarnessResumeRoutes(state) : resolveHarnessModelRoutes();
    await replaceHarness(nextOptions, nextRoutes);
    session = selected;
    messages = state?.messages ?? [];
  };

  const statusLine = async () => {
    const current = await refreshSession();
    const latest = current.runs.at(-1);
    const routeText = routes.size === 0
      ? "default"
      : [...routes.values()].map((route) => `${route.profile}=${route.provider}:${route.model}`).join(", ");
    return `session ${current.sessionId} · ${harness.config.provider}/${harness.config.model}` +
      ` · ${messages.length} messages · routes ${routeText}` +
      `${latest ? ` · last ${latest.runId} (${latest.status})` : ""}`;
  };

  process.stderr.write(
    `Zhivex Harness ${HARNESS_VERSION} · ${harness.config.provider}/${harness.config.model}\n` +
    `session ${session.sessionId}\n` +
    "Type /help for console commands.\n"
  );

  try {
    for (;;) {
      const prompt = (await readline.question("\n> ")).trim();
      if (!prompt) {
        continue;
      }
      if (prompt === "/exit" || prompt === "/quit") {
        break;
      }
      if (prompt === "/help") {
        process.stderr.write(
          "/provider [id] · /model [id] · /route [role=provider[:model]] · /status\n" +
          "/diff · /review <task> · /resume <last|sessionId> · /compact\n" +
          "/new [title] · /rename <title> · /clear · /exit\n"
        );
        continue;
      }
      if (prompt === "/clear") {
        messages = [];
        process.stderr.write("Context cleared.\n");
        continue;
      }
      if (prompt === "/status") {
        process.stderr.write(`${await statusLine()}\n`);
        continue;
      }
      if (prompt === "/diff") {
        const diff = await harness.workspace.gitDiff();
        const output = `${diff.status.stdout}${diff.diff.stdout}${diff.staged.stdout}`;
        process.stdout.write(output || "No workspace changes.\n");
        continue;
      }
      if (prompt === "/compact") {
        messages = compactHarnessMessages(messages);
        process.stderr.write(`Context compacted to ${messages.length} redacted message(s).\n`);
        continue;
      }
      if (prompt === "/provider" || prompt.startsWith("/provider ")) {
        const value = prompt.slice("/provider".length).trim();
        if (!value) {
          process.stderr.write(`${providerAvailability().map((provider) =>
            `${provider.id}${provider.id === harness.config.provider ? "*" : ""}`
          ).join(" ")}\n`);
          continue;
        }
        const active = await hasActiveTurn();
        if (active) {
          process.stderr.write(`Cannot switch provider while run ${active.runId} is ${active.status}.\n`);
          continue;
        }
        const provider = parseProvider(value);
        const model = DEFAULT_PROVIDER_REGISTRY.descriptor(provider).defaultModel;
        const portableMessages = compactHarnessMessages(messages);
        await replaceHarness({ ...runtimeOptions, provider, model }, routes);
        messages = portableMessages;
        process.stderr.write(`Next turn: ${provider}/${model}; context was compacted for a safe handoff.\n`);
        continue;
      }
      if (prompt === "/model" || prompt.startsWith("/model ")) {
        const value = prompt.slice("/model".length).trim();
        if (!value) {
          process.stderr.write(`${harness.config.provider}/${harness.config.model}\n`);
          continue;
        }
        const active = await hasActiveTurn();
        if (active) {
          process.stderr.write(`Cannot switch model while run ${active.runId} is ${active.status}.\n`);
          continue;
        }
        const portableMessages = compactHarnessMessages(messages);
        await replaceHarness({ ...runtimeOptions, model: value }, routes);
        messages = portableMessages;
        process.stderr.write(`Next turn: ${harness.config.provider}/${value}; context was compacted.\n`);
        continue;
      }
      if (prompt === "/route" || prompt.startsWith("/route ")) {
        const value = prompt.slice("/route".length).trim();
        if (!value) {
          process.stderr.write(`${JSON.stringify(serializeHarnessModelRoutes(routes))}\n`);
          continue;
        }
        const active = await hasActiveTurn();
        if (active) {
          process.stderr.write(`Cannot change routes while run ${active.runId} is ${active.status}.\n`);
          continue;
        }
        const nextRoutes = new Map(routes);
        if (value === "clear") {
          nextRoutes.clear();
        } else if (value.startsWith("clear ")) {
          const profile = value.slice("clear ".length).trim() as HarnessSubagentProfile;
          if (!(HARNESS_SUBAGENT_PROFILES as readonly string[]).includes(profile)) {
            process.stderr.write(`Unknown subagent profile: ${profile}.\n`);
            continue;
          }
          nextRoutes.delete(profile);
        } else {
          const route = parseHarnessModelRoute(value);
          nextRoutes.set(route.profile, route);
        }
        await replaceHarness(runtimeOptions, nextRoutes);
        process.stderr.write(`Routes: ${JSON.stringify(serializeHarnessModelRoutes(routes))}\n`);
        continue;
      }
      if (prompt === "/new" || prompt.startsWith("/new ")) {
        const active = await hasActiveTurn();
        if (active) {
          process.stderr.write(`Cannot leave session while run ${active.runId} is ${active.status}.\n`);
          continue;
        }
        const title = prompt.slice("/new".length).trim();
        const created = await sessionStore.create(title ? { title } : undefined);
        await restoreSession(created);
        process.stderr.write(`Created session ${session.sessionId}.\n`);
        continue;
      }
      if (prompt === "/rename" || prompt.startsWith("/rename ")) {
        const title = prompt.slice("/rename".length).trim();
        if (!title) {
          process.stderr.write("Usage: /rename <title>\n");
          continue;
        }
        session = await sessionStore.rename(session.sessionId, title);
        process.stderr.write(`Renamed session to ${session.title}.\n`);
        continue;
      }
      if (prompt === "/resume" || prompt.startsWith("/resume ")) {
        const selector = prompt.slice("/resume".length).trim() || "last";
        const selected = selector === "last"
          ? await sessionStore.latest({ includeArchived: true })
          : await sessionStore.get(selector);
        if (!selected) {
          process.stderr.write(`Session ${selector} was not found.\n`);
          continue;
        }
        await restoreSession(selected);
        const active = await hasActiveTurn();
        process.stderr.write(
          active
            ? `Session ${session.sessionId} has run ${active.runId} waiting in ${active.status}; use zhx resume ${active.runId} --approve|--deny.\n`
            : `Resumed session ${session.sessionId}.\n`
        );
        continue;
      }
      if (prompt === "/review" || prompt.startsWith("/review ")) {
        const reviewPrompt = prompt.slice("/review".length).trim();
        if (!reviewPrompt) {
          process.stderr.write("Usage: /review <task>\n");
          continue;
        }
        const active = await hasActiveTurn();
        if (active) {
          process.stderr.write(`Cannot start a review while run ${active.runId} is ${active.status}.\n`);
          continue;
        }
        const review = await withTemporaryProfiles(
          ["explorer", "reviewer"],
          () => runHarnessReviewGroup(
            harness,
            { prompt: reviewPrompt, scope: harness.config.scope },
            ["explorer", "reviewer"]
          )
        );
        for (const output of review.outputs) {
          process.stdout.write(`\n[${output.name ?? output.agentId ?? "reviewer"}] ${output.status}\n`);
          if (output.output?.outputText) process.stdout.write(`${output.output.outputText}\n`);
        }
        continue;
      }

      const active = await hasActiveTurn();
      if (active) {
        process.stderr.write(
          `Run ${active.runId} is ${active.status}; resolve it with zhx resume ${active.runId} --approve|--deny before a new turn.\n`
        );
        continue;
      }

      const runId = `run_${randomUUID()}`;
      session = await sessionStore.appendRun(session.sessionId, {
        runId,
        provider: harness.config.provider,
        model: harness.config.model,
        status: "created"
      });
      const turn = session.runs.at(-1)!;

      const tracker = { streamedText: false };
      let markedRunning = false;
      let result: AgentRunOutput;
      try {
        result = await runHarness(
          harness,
          messages.length === 0
            ? {
                runId,
                prompt,
                scope: harness.config.scope,
                metadata: {
                  ...createHarnessResumeMetadata(harness.config, routes),
                  zhivexCliSession: {
                    schemaVersion: 1,
                    sessionId: session.sessionId,
                    turnId: turn.turnId,
                    sequence: turn.sequence
                  }
                }
              }
            : {
                runId,
                messages: appendUserMessage(messages, prompt),
                scope: harness.config.scope,
                metadata: {
                  ...createHarnessResumeMetadata(harness.config, routes),
                  zhivexCliSession: {
                    schemaVersion: 1,
                    sessionId: session.sessionId,
                    turnId: turn.turnId,
                    sequence: turn.sequence
                  }
                }
              },
          {
            onEvent: async (event) => {
              if (!markedRunning && event.type === "agent-run-start") {
                session = await sessionStore.updateRun(session.sessionId, runId, { status: "running" });
                markedRunning = true;
              }
              await streamSink({ json: false, jsonl: false }, tracker)(event);
            },
            resolveApprovals: terminalApprovalResolver(options.yes, (question) => readline.question(question))
          }
        );
      } catch (error) {
        session = await sessionStore.updateRun(session.sessionId, runId, { status: "failed" });
        throw error;
      }
      if (!tracker.streamedText && result.outputText) {
        process.stdout.write(result.outputText);
      }
      process.stdout.write("\n");
      messages = result.messages;
      session = await sessionStore.updateRun(session.sessionId, runId, {
        status: sessionStatus(result.status)
      });
      if (result.status === "waiting_approval") {
        process.stderr.write(
          `Run paused: ${result.state.runId}. Resume with zhx resume ${result.state.runId} --approve|--deny.\n`
        );
      }
    }
  } finally {
    readline.close();
    harness.close();
    sessionStore.close();
  }
};

export const providersDocument = (env: NodeJS.ProcessEnv = process.env) => ({
  schemaVersion: CLI_JSON_SCHEMA_VERSION,
  kind: "providers" as const,
  providers: providerAvailability(env)
});

const listProviders = (json: boolean) => {
  const document = providersDocument();
  if (json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  for (const provider of document.providers) {
    process.stdout.write(
      `${provider.id.padEnd(7)} ${provider.defaultModel.padEnd(22)} ${provider.support.padEnd(11)} ${provider.configured ? "configured" : `missing ${provider.credentialNames.join("/")}`}\n`
    );
  }
};

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details: Record<string, boolean | number | string | readonly string[]>;
}

export interface DoctorReport {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  kind: "doctor";
  ok: boolean;
  harnessVersion: string;
  configSchemaVersion: number;
  configuration: {
    provider: HarnessProvider;
    model: string;
    workspace: string;
    stateDirectory: string;
    storeBackend: string;
    scope: ReturnType<typeof resolveHarnessConfig>["scope"];
    maxSteps: number;
    timeoutMs: number;
    budget: ReturnType<typeof resolveHarnessConfig>["budget"];
    costBudget?: ReturnType<typeof resolveHarnessConfig>["costBudget"];
    compaction: ReturnType<typeof resolveHarnessConfig>["compaction"];
    allowedChecks: readonly string[];
    requiredCapabilities: ReturnType<typeof resolveHarnessConfig>["requiredCapabilities"];
    orchestration: ReturnType<typeof resolveHarnessConfig>["orchestration"];
    execution: ReturnType<typeof resolveHarnessConfig>["execution"];
    mcpConfigPath?: string;
  };
  checks: DoctorCheck[];
  providers: ReturnType<typeof providerAvailability>;
}

export interface DoctorContext {
  env?: NodeJS.ProcessEnv;
  bunVersion?: string;
  ociRuntimeAdapter?: HarnessOciRuntimeAdapter;
}

const sensitiveStateSegments = new Set([
  ".git",
  ".env",
  ".npmrc",
  "dist",
  "node_modules",
  "src"
]);

const isSensitiveStateSegment = (segment: string) => {
  const normalized = segment.toLowerCase();
  return sensitiveStateSegments.has(normalized) ||
    normalized.startsWith(".env.") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx");
};

const parseNumericVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])] as const
    : undefined;
};

const satisfiesBunEngine = (version: string, range: string) => {
  const minimumMatch = /^>=(\d+\.\d+\.\d+)$/.exec(range.trim());
  const actual = parseNumericVersion(version);
  const minimum = minimumMatch ? parseNumericVersion(minimumMatch[1] ?? "") : undefined;
  if (!actual || !minimum) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }
  return true;
};

const diagnostic = (
  id: string,
  status: DoctorCheckStatus,
  message: string,
  details: DoctorCheck["details"] = {}
): DoctorCheck => ({ id, status, message, details });

const inspectWorkspace = async (workspace: string): Promise<DoctorCheck> => {
  try {
    const workspaceStat = await stat(workspace);
    if (!workspaceStat.isDirectory()) {
      return diagnostic("workspace", "fail", "Workspace is not a directory.", { path: workspace });
    }
    await access(workspace, fsConstants.R_OK);
    return diagnostic("workspace", "pass", "Workspace exists and is readable.", { path: workspace });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return diagnostic("workspace", "fail", "Workspace cannot be read.", { path: workspace, code });
  }
};

const inspectGit = async (workspace: string): Promise<DoctorCheck> => {
  try {
    const versionProcess = Bun.spawn(["git", "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore"
    });
    const [versionOutput, versionExitCode] = await Promise.all([
      new Response(versionProcess.stdout).text(),
      versionProcess.exited
    ]);
    if (versionExitCode !== 0) {
      return diagnostic("git", "warn", "Git is unavailable.", { installed: false });
    }

    const repositoryProcess = Bun.spawn(["git", "-C", workspace, "rev-parse", "--is-inside-work-tree"], {
      env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore"
    });
    const [repositoryOutput, repositoryExitCode] = await Promise.all([
      new Response(repositoryProcess.stdout).text(),
      repositoryProcess.exited
    ]);
    const repository = repositoryExitCode === 0 && repositoryOutput.trim() === "true";
    return diagnostic(
      "git",
      repository ? "pass" : "warn",
      repository ? "Git is installed and the workspace is a repository." : "Git is installed, but the workspace is not a repository.",
      { installed: true, repository, version: versionOutput.trim() }
    );
  } catch {
    return diagnostic("git", "warn", "Git is unavailable.", { installed: false });
  }
};

const inspectScripts = async (workspace: string, allowedChecks: readonly string[]): Promise<DoctorCheck> => {
  const packagePath = path.join(workspace, "package.json");
  try {
    const packageStat = await stat(packagePath);
    if (!packageStat.isFile() || packageStat.size > 1024 * 1024) {
      return diagnostic("scripts", "warn", "package.json is not a readable regular file.", {
        packageJson: false,
        available: []
      });
    }
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: unknown };
    const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts as Record<string, unknown>
      : {};
    const available = allowedChecks.filter((name) => typeof scripts[name] === "string");
    const missing = allowedChecks.filter((name) => typeof scripts[name] !== "string");
    return diagnostic(
      "scripts",
      available.length > 0 ? "pass" : "warn",
      available.length > 0 ? "Supported Bun check scripts were found." : "No supported Bun check scripts were found.",
      { packageJson: true, available, missing }
    );
  } catch (error) {
    const code = error instanceof SyntaxError
      ? "INVALID_JSON"
      : (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return diagnostic("scripts", "warn", "package.json could not be inspected.", {
      packageJson: false,
      available: [],
      code
    });
  }
};

const isInsidePath = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const containsSymlink = async (candidate: string, trustedPrefix?: string) => {
  const parsed = path.parse(candidate);
  const parts = trustedPrefix
    ? path.relative(trustedPrefix, candidate).split(path.sep).filter(Boolean)
    : candidate.slice(parsed.root.length).split(path.sep).filter(Boolean).slice(1);
  let current = trustedPrefix ?? path.join(parsed.root, candidate.slice(parsed.root.length).split(path.sep).filter(Boolean)[0] ?? "");
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
  return false;
};

const nearestExistingPath = async (candidate: string) => {
  let current = candidate;
  for (;;) {
    try {
      return { path: current, stat: await stat(current) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
};

const inspectStateDirectory = async (workspace: string, stateDirectory: string): Promise<DoctorCheck> => {
  if (stateDirectory === workspace) {
    return diagnostic("state-directory", "fail", "State directory cannot be the workspace root.", {
      path: stateDirectory,
      writable: false
    });
  }

  if (isInsidePath(workspace, stateDirectory)) {
    const segments = path.relative(workspace, stateDirectory).split(path.sep).filter(Boolean);
    const sensitiveSegment = segments.find(isSensitiveStateSegment);
    if (sensitiveSegment) {
      return diagnostic("state-directory", "fail", "State directory is inside a sensitive workspace path.", {
        path: stateDirectory,
        sensitiveSegment,
        writable: false
      });
    }
  }

  try {
    const trustedPrefix = isInsidePath(workspace, stateDirectory) ? workspace : undefined;
    if (await containsSymlink(stateDirectory, trustedPrefix)) {
      return diagnostic("state-directory", "fail", "State directory must not resolve through a symbolic link.", {
        path: stateDirectory,
        writable: false
      });
    }
    const existing = await nearestExistingPath(stateDirectory);
    if (!existing.stat.isDirectory()) {
      return diagnostic("state-directory", "fail", "State directory or its nearest existing parent is not a directory.", {
        path: stateDirectory,
        writable: false
      });
    }
    await access(existing.path, fsConstants.R_OK | fsConstants.W_OK);
    return diagnostic("state-directory", "pass", "State directory is safe and writable.", {
      path: stateDirectory,
      exists: existing.path === stateDirectory,
      writable: true
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return diagnostic("state-directory", "fail", "State directory is not writable.", {
      path: stateDirectory,
      writable: false,
      code
    });
  }
};

const inspectOperationsStore = async (
  stateDirectory: string,
  storeBackend: string
): Promise<DoctorCheck> => {
  if (storeBackend === "file") {
    return diagnostic("operations-store", "warn", "Legacy file run store is selected.", {
      backend: storeBackend,
      migrationAvailable: true
    });
  }
  const databasePath = path.join(stateDirectory, "operations.sqlite");
  try {
    const entry = await lstat(databasePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return diagnostic("operations-store", "fail", "SQLite state path is not a regular file.", {
        backend: storeBackend,
        databasePath,
        safe: false
      });
    }
    return diagnostic("operations-store", "pass", "SQLite durable operations store is available.", {
      backend: storeBackend,
      databasePath,
      safe: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return diagnostic("operations-store", "pass", "SQLite durable operations store will be created on first use.", {
        backend: storeBackend,
        databasePath,
        safe: true
      });
    }
    return diagnostic("operations-store", "fail", "SQLite durable operations store could not be inspected.", {
      backend: storeBackend,
      databasePath,
      safe: false,
      code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN"
    });
  }
};

const inspectMcpConfiguration = async (
  workspace: string,
  configPath: string | undefined
): Promise<DoctorCheck> => {
  if (!configPath) {
    return diagnostic("mcp-config", "pass", "No MCP servers are configured.", {
      configured: false,
      servers: 0
    });
  }
  try {
    const configuration = await loadHarnessMcpConfiguration(workspace, configPath);
    return diagnostic("mcp-config", "pass", "Governed MCP configuration is valid.", {
      configured: true,
      servers: configuration.servers.length,
      names: configuration.servers.map((server) => server.name)
    });
  } catch (error) {
    return diagnostic("mcp-config", "fail", "MCP configuration is invalid or unsafe.", {
      configured: true,
      servers: 0,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const inspectExecutionEnvironment = async (
  execution: ReturnType<typeof resolveHarnessConfig>["execution"],
  runtimeOverride?: HarnessOciRuntimeAdapter
): Promise<DoctorCheck> => {
  if (execution.backend === "none") {
    return diagnostic("execution-environment", "pass", "Enforced OCI execution is disabled; shell-class tools remain unavailable.", {
      backend: "none",
      shellAvailable: false
    });
  }
  try {
    const runtime = runtimeOverride ?? new CliOciRuntimeAdapter(execution.runtime);
    const image = await runtime.inspectImage(execution.image);
    return diagnostic("execution-environment", "pass", "OCI runtime and preloaded image are available.", {
      backend: "oci",
      runtime: image.runtime,
      runtimeVersion: image.runtimeVersion,
      imageReference: image.imageReference,
      imageDigest: image.imageDigest,
      network: "deny",
      shellAvailable: true
    });
  } catch (error) {
    return diagnostic("execution-environment", "fail", "OCI execution was requested, but the runtime or preloaded image is unavailable.", {
      backend: "oci",
      runtime: execution.runtime,
      imageReference: execution.image,
      error: error instanceof Error ? error.message : String(error),
      shellAvailable: false
    });
  }
};

export const createDoctorReport = async (
  options: Pick<
    CliOptions,
    | "provider"
    | "model"
    | "workspace"
    | "stateDirectory"
    | "storeBackend"
    | "tenantId"
    | "userId"
    | "namespace"
    | "maxSteps"
    | "timeoutMs"
    | "maxToolCalls"
    | "maxToolErrors"
    | "maxInputTokens"
    | "maxOutputTokens"
    | "maxTotalTokens"
    | "maxCostUsd"
    | "inputCostPerMillion"
    | "outputCostPerMillion"
    | "allowedChecks"
    | "requiredCapabilities"
    | "subagentProfiles"
    | "subagentMaxSteps"
    | "subagentMaxToolCalls"
    | "subagentMaxToolErrors"
    | "subagentMaxInputTokens"
    | "subagentMaxOutputTokens"
    | "subagentMaxTotalTokens"
    | "subagentTimeoutMs"
    | "maxParallelReviews"
    | "executionBackend"
    | "ociRuntime"
    | "ociImage"
    | "ociAllowedCommands"
    | "ociMaxProcessRuntimeMs"
    | "ociMaxProcessOutputBytes"
    | "ociMaxMemoryMb"
    | "ociMaxPids"
    | "ociMaxCpus"
    | "ociMaxWorkspaceBytes"
    | "ociMaxFileWriteBytes"
    | "ociTmpfsMb"
    | "mcpConfigPath"
  > = {},
  context: DoctorContext = {}
): Promise<DoctorReport> => {
  const env = context.env ?? process.env;
  const config = resolveHarnessConfig({
    ...(env.ZHIVEX_HARNESS_PROVIDER ? { provider: env.ZHIVEX_HARNESS_PROVIDER } : {}),
    ...(env.ZHIVEX_HARNESS_MODEL ? { model: env.ZHIVEX_HARNESS_MODEL } : {}),
    ...(env.ZHIVEX_HARNESS_MAX_STEPS
      ? { maxSteps: Number(env.ZHIVEX_HARNESS_MAX_STEPS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_STORE ? { storeBackend: env.ZHIVEX_HARNESS_STORE } : {}),
    ...(env.ZHIVEX_HARNESS_TENANT_ID ? { tenantId: env.ZHIVEX_HARNESS_TENANT_ID } : {}),
    ...(env.ZHIVEX_HARNESS_USER_ID ? { userId: env.ZHIVEX_HARNESS_USER_ID } : {}),
    ...(env.ZHIVEX_HARNESS_NAMESPACE ? { namespace: env.ZHIVEX_HARNESS_NAMESPACE } : {}),
    ...(env.ZHIVEX_HARNESS_TIMEOUT_MS
      ? { timeoutMs: Number(env.ZHIVEX_HARNESS_TIMEOUT_MS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_TOOL_CALLS
      ? { maxToolCalls: Number(env.ZHIVEX_HARNESS_MAX_TOOL_CALLS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_TOOL_ERRORS
      ? { maxToolErrors: Number(env.ZHIVEX_HARNESS_MAX_TOOL_ERRORS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_INPUT_TOKENS
      ? { maxInputTokens: Number(env.ZHIVEX_HARNESS_MAX_INPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS
      ? { maxOutputTokens: Number(env.ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_TOTAL_TOKENS
      ? { maxTotalTokens: Number(env.ZHIVEX_HARNESS_MAX_TOTAL_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_COST_USD
      ? { maxCostUsd: Number(env.ZHIVEX_HARNESS_MAX_COST_USD) }
      : {}),
    ...(env.ZHIVEX_HARNESS_INPUT_COST_PER_MILLION
      ? { inputCostPerMillion: Number(env.ZHIVEX_HARNESS_INPUT_COST_PER_MILLION) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OUTPUT_COST_PER_MILLION
      ? { outputCostPerMillion: Number(env.ZHIVEX_HARNESS_OUTPUT_COST_PER_MILLION) }
      : {}),
    ...(env.ZHIVEX_HARNESS_COMPACTION_MAX_MESSAGES
      ? { compactionMaxMessages: Number(env.ZHIVEX_HARNESS_COMPACTION_MAX_MESSAGES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_COMPACTION_MAX_INPUT_TOKENS
      ? { compactionMaxEstimatedInputTokens: Number(env.ZHIVEX_HARNESS_COMPACTION_MAX_INPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_COMPACTION_KEEP_RECENT
      ? { compactionKeepRecentMessages: Number(env.ZHIVEX_HARNESS_COMPACTION_KEEP_RECENT) }
      : {}),
    ...(env.ZHIVEX_HARNESS_ALLOWED_CHECKS !== undefined
      ? { allowedChecks: env.ZHIVEX_HARNESS_ALLOWED_CHECKS.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_REQUIRED_CAPABILITIES !== undefined
      ? { requiredCapabilities: env.ZHIVEX_HARNESS_REQUIRED_CAPABILITIES.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENTS !== undefined
      ? { subagentProfiles: env.ZHIVEX_HARNESS_SUBAGENTS.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_STEPS
      ? { subagentMaxSteps: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_STEPS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_CALLS
      ? { subagentMaxToolCalls: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_CALLS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_ERRORS
      ? { subagentMaxToolErrors: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_ERRORS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_INPUT_TOKENS
      ? { subagentMaxInputTokens: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_INPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_OUTPUT_TOKENS
      ? { subagentMaxOutputTokens: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_OUTPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOTAL_TOKENS
      ? { subagentMaxTotalTokens: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOTAL_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_TIMEOUT_MS
      ? { subagentTimeoutMs: Number(env.ZHIVEX_HARNESS_SUBAGENT_TIMEOUT_MS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_PARALLEL_REVIEWS
      ? { maxParallelReviews: Number(env.ZHIVEX_HARNESS_MAX_PARALLEL_REVIEWS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_EXECUTION ? { executionBackend: env.ZHIVEX_HARNESS_EXECUTION } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_RUNTIME ? { ociRuntime: env.ZHIVEX_HARNESS_OCI_RUNTIME } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_IMAGE ? { ociImage: env.ZHIVEX_HARNESS_OCI_IMAGE } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS !== undefined
      ? { ociAllowedCommands: env.ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS
      ? { ociMaxProcessRuntimeMs: Number(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES
      ? { ociMaxProcessOutputBytes: Number(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB
      ? { ociMaxMemoryMb: Number(env.ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_PIDS ? { ociMaxPids: Number(env.ZHIVEX_HARNESS_OCI_MAX_PIDS) } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_CPUS ? { ociMaxCpus: Number(env.ZHIVEX_HARNESS_OCI_MAX_CPUS) } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES
      ? { ociMaxWorkspaceBytes: Number(env.ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES
      ? { ociMaxFileWriteBytes: Number(env.ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_TMPFS_MB ? { ociTmpfsMb: Number(env.ZHIVEX_HARNESS_OCI_TMPFS_MB) } : {}),
    ...(env.ZHIVEX_HARNESS_MCP_CONFIG ? { mcpConfigPath: env.ZHIVEX_HARNESS_MCP_CONFIG } : {}),
    ...options
  });
  const bunVersion = context.bunVersion ?? Bun.version;
  const providers = providerAvailability(env);
  const selectedProvider = providers.find((provider) => provider.id === config.provider);
  const checks: DoctorCheck[] = [];

  checks.push(diagnostic(
    "bun",
    satisfiesBunEngine(bunVersion, BUN_ENGINE_RANGE) ? "pass" : "fail",
    satisfiesBunEngine(bunVersion, BUN_ENGINE_RANGE)
      ? "Bun satisfies the package engine requirement."
      : "Bun does not satisfy the package engine requirement.",
    { version: bunVersion, required: BUN_ENGINE_RANGE }
  ));
  checks.push(await inspectWorkspace(config.workspace));
  checks.push(await inspectGit(config.workspace));
  checks.push(await inspectScripts(config.workspace, config.allowedChecks));
  checks.push(await inspectStateDirectory(config.workspace, config.stateDirectory));
  checks.push(await inspectOperationsStore(config.stateDirectory, config.storeBackend));
  checks.push(await inspectMcpConfiguration(config.workspace, config.mcpConfigPath));
  checks.push(await inspectExecutionEnvironment(config.execution, context.ociRuntimeAdapter));

  for (const provider of providers) {
    const invalidRegion = provider.id === "qwen" && provider.configuration.regionValid === false;
    const invalidEndpoint = !provider.configuration.endpointValid;
    const selected = provider.id === selectedProvider?.id;
    const status: DoctorCheckStatus = invalidRegion || invalidEndpoint || !provider.configured
      ? selected
        ? "fail"
        : "warn"
      : provider.support === "provisional"
        ? "warn"
        : "pass";
    const message = invalidEndpoint
      ? `${provider.name} custom endpoint configuration is invalid.`
      : invalidRegion
      ? "Qwen region configuration is invalid."
      : provider.configured
        ? provider.support === "provisional"
          ? `${provider.name} credentials are present, but live support is provisional.`
          : `${provider.name} credentials are present.`
        : `${provider.name} credentials are missing.`;
    checks.push(diagnostic(`provider:${provider.id}`, status, message, {
      provider: provider.id,
      selected,
      configured: provider.configured,
      support: provider.support,
      credentialNames: provider.credentialNames,
      capabilities: provider.capabilities,
      customEndpoint: provider.configuration.customEndpoint,
      endpointValid: provider.configuration.endpointValid,
      endpointSecure: provider.configuration.endpointSecure,
      ...(provider.id === "qwen"
        ? {
            regionConfigured: provider.configuration.regionConfigured,
            regionValid: provider.configuration.regionValid,
            workspaceIdConfigured: provider.configuration.workspaceIdConfigured
          }
        : {})
    }));
  }

  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    kind: "doctor",
    ok: !checks.some((check) => check.status === "fail"),
    harnessVersion: HARNESS_VERSION,
    configSchemaVersion: config.schemaVersion,
    configuration: {
      provider: config.provider,
      model: config.model,
      workspace: config.workspace,
      stateDirectory: config.stateDirectory,
      storeBackend: config.storeBackend,
      scope: config.scope,
      maxSteps: config.maxSteps,
      timeoutMs: config.timeoutMs,
      budget: config.budget,
      ...(config.costBudget ? { costBudget: config.costBudget } : {}),
      compaction: config.compaction,
      allowedChecks: config.allowedChecks,
      requiredCapabilities: config.requiredCapabilities,
      orchestration: config.orchestration,
      execution: config.execution,
      ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {})
    },
    checks,
    providers
  };
};

export const formatDoctorReport = (report: DoctorReport) => {
  const symbols: Record<DoctorCheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };
  const lines = [
    `Zhivex Harness doctor v${report.harnessVersion}`,
    ...report.checks.map((check) => `${symbols[check.status]} ${check.id}: ${check.message}`),
    report.ok ? "Doctor completed without blocking problems." : "Doctor found blocking problems."
  ];
  return `${lines.join("\n")}\n`;
};

const doctor = async (options: CliOptions) => {
  const report = await createDoctorReport(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) {
    process.exitCode = CLI_EXIT_CODES.doctorFailed;
  }
};

const printRunsDocument = (document: unknown, json: boolean) => {
  if (json || !document || typeof document !== "object") {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const record = document as Record<string, unknown>;
  if (record.kind === "run-list" && Array.isArray(record.runs)) {
    for (const run of record.runs as Array<Record<string, unknown>>) {
      process.stdout.write(
        `${String(run.runId).padEnd(30)} ${String(run.status).padEnd(18)} ${String(run.provider)}/${String(run.model)} ${String(run.steps)} steps\n`
      );
    }
    if (typeof record.nextCursor === "string") {
      process.stderr.write(`next cursor: ${record.nextCursor}\n`);
    }
    return;
  }
  if (record.kind === "run-inspection") {
    const run = record.run as Record<string, unknown>;
    process.stdout.write(
      `${String(run.runId)} · ${String(run.status)} · ${String(run.provider)}/${String(run.model)} · ${String(run.steps)} steps · ${String(run.toolCalls)} tools\n`
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
};

const manageRuns = async (options: CliOptions) => {
  const config = resolveHarnessConfig(options);
  await validateStateDirectory(config.workspace, config.stateDirectory);
  const persistence = await openHarnessPersistence(config);
  try {
    let document: unknown;
    switch (options.runsCommand) {
      case "list":
        document = await listHarnessRuns(persistence.store, config, {
          ...(options.statuses ? { statuses: options.statuses } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {})
        });
        break;
      case "inspect":
        document = await inspectHarnessRun(persistence.store, config, options.runId!);
        break;
      case "export": {
        const inspection = await inspectHarnessRun(persistence.store, config, options.runId!);
        document = { ...inspection, kind: "run-export" as const };
        break;
      }
      case "cancel":
        document = await cancelHarnessRun(persistence.store, config, options.runId!, {
          ...(options.reason ? { reason: options.reason } : {}),
          cascade: options.cascade,
          final: options.final
        });
        break;
      case "cleanup":
        document = await cleanupHarnessRuns(persistence.store, config, {
          before: options.before!,
          ...(options.statuses ? { statuses: options.statuses } : {}),
          ...(options.limit ? { limit: options.limit } : {})
        });
        document = {
          ...(document as Record<string, unknown>),
          executionArtifacts: await cleanupHarnessExecutionArtifacts(config.stateDirectory, options.before!),
          ...(config.execution.backend === "oci"
            ? {
                orphanContainersRemoved: await new CliOciRuntimeAdapter(
                  config.execution.runtime
                ).cleanupOrphans()
              }
            : {})
        };
        break;
      default:
        throw new CliUsageError("runs requires one of: list, inspect, cancel, cleanup, export.");
    }
    printRunsDocument(document, options.json);
  } finally {
    persistence.close();
  }
};

const openSessionStoreForConfig = (config: HarnessConfig) => openCliSessionStore({
  workspace: config.workspace,
  stateDirectory: config.stateDirectory,
  scope: config.scope
});

const printSessionDocument = (document: unknown, json: boolean) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const record = document as { kind?: string; sessions?: CliSession[]; session?: CliSession };
  if (record.kind === "session-list") {
    for (const session of record.sessions ?? []) {
      const latest = session.runs.at(-1);
      process.stdout.write(
        `${session.sessionId} ${session.title ?? "(untitled)"} · ${session.runs.length} runs` +
        `${latest ? ` · ${latest.provider}/${latest.model} · ${latest.status}` : ""}\n`
      );
    }
    return;
  }
  const session = record.session;
  if (session) {
    process.stdout.write(
      `${session.sessionId} · ${session.title ?? "(untitled)"} · ${session.runs.length} runs` +
      `${session.archivedAt ? " · archived" : ""}\n`
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
};

const manageSessions = async (options: CliOptions) => {
  const config = resolveHarnessConfig(options);
  const store = await openSessionStoreForConfig(config);
  try {
    let session: CliSession | undefined;
    let document: unknown;
    switch (options.sessionsCommand) {
      case "list": {
        const summaries = await store.list(options.limit ? { limit: options.limit } : undefined);
        const sessions = (await Promise.all(summaries.map((summary) => store.get(summary.sessionId))))
          .filter((value): value is CliSession => Boolean(value));
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session-list" as const, sessions };
        break;
      }
      case "inspect":
        session = await store.get(options.sessionId!);
        if (!session) throw new Error(`Session ${options.sessionId} was not found.`);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      case "rename":
        session = await store.rename(options.sessionId!, options.sessionTitle!);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      case "fork":
        session = await store.fork(options.sessionId!);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      case "archive":
        session = await store.archive(options.sessionId!);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      default:
        throw new CliUsageError("sessions requires one of: list, inspect, rename, fork, archive.");
    }
    printSessionDocument(document, options.json);
  } finally {
    store.close();
  }
};

const sessionStatus = (status: AgentStatus): SessionRunStatus => {
  if (status === "queued") return "created";
  if (status === "suspended") return "waiting_approval";
  return status;
};

const updateIndexedSessionRun = async (
  config: HarnessConfig,
  runId: string,
  status: AgentStatus
) => {
  const store = await openSessionStoreForConfig(config);
  try {
    for (const summary of await store.list({ limit: 200, includeArchived: true })) {
      const session = await store.get(summary.sessionId);
      if (session?.runs.some((run) => run.runId === runId)) {
        await store.updateRun(session.sessionId, runId, { status: sessionStatus(status) });
        return;
      }
    }
  } finally {
    store.close();
  }
};

export const cliExitCodeForError = (error: unknown) =>
  error instanceof CliUsageError ? CLI_EXIT_CODES.usageError : CLI_EXIT_CODES.runtimeError;

const MAX_CHANGE_ENVELOPE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CHANGE_ARTIFACT_BYTES = 64 * 1024 * 1024;

const readStableCliArtifact = async (filePath: string, maxBytes: number) => {
  const absolute = path.resolve(process.cwd(), filePath);
  try {
    const before = await lstat(absolute);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new CliUsageError(`Change artifact must be a regular non-symlink file: ${filePath}`);
    }
    if (before.size > maxBytes) {
      throw new CliUsageError(`Change artifact exceeds the ${maxBytes}-byte limit: ${filePath}`);
    }
    const contents = await readFile(absolute);
    const after = await lstat(absolute);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new CliUsageError(`Change artifact changed while it was being read: ${filePath}`);
    }
    return contents;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const code = error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (typeof code === "string") {
      throw new CliUsageError(`Change artifact cannot be read (${code}): ${filePath}`);
    }
    throw error;
  }
};

const readCliJsonArtifact = async (filePath: string): Promise<unknown> => {
  const contents = await readStableCliArtifact(filePath, MAX_CHANGE_ENVELOPE_JSON_BYTES);
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new CliUsageError(`Change artifact is not valid JSON: ${filePath}`);
  }
};

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
};

const manageChanges = async (options: CliOptions) => {
  if (!options.changesCommand || !options.artifactPath || !options.patchPath) {
    throw new CliUsageError("Incomplete changes command.");
  }
  const patchBytes = await readStableCliArtifact(options.patchPath, MAX_CHANGE_ARTIFACT_BYTES);
  const patchDigest = digestChangeEnvelopeArtifact(patchBytes);

  if (options.changesCommand === "create") {
    const input = objectValue(await readCliJsonArtifact(options.artifactPath), "Change envelope input");
    const patchInput = objectValue(input.patch, "Change envelope patch");
    if (patchInput.patchDigest !== undefined && patchInput.patchDigest !== patchDigest) {
      throw new CliUsageError("The declared patch.patchDigest does not match the exact --patch bytes.");
    }
    const envelope = createChangeEnvelope({
      ...input,
      patch: { ...patchInput, patchDigest }
    });
    process.stdout.write(`${canonicalizeChangeEnvelope(envelope)}\n`);
    return;
  }

  const envelope = await readCliJsonArtifact(options.artifactPath);
  const suppliedPreconditions = options.preconditionsPath
    ? objectValue(await readCliJsonArtifact(options.preconditionsPath), "Change envelope preconditions")
    : {};
  if (suppliedPreconditions.patchDigest !== undefined && suppliedPreconditions.patchDigest !== patchDigest) {
    throw new CliUsageError("The precondition patchDigest does not match the exact --patch bytes.");
  }
  const preconditions: ChangeEnvelopePreconditions = changeEnvelopePreconditionsSchema.parse({
    ...suppliedPreconditions,
    patchDigest
  });
  const result = verifyChangeEnvelope(envelope, {
    ...(options.verificationTime ? { now: options.verificationTime } : {}),
    preconditions
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "change-envelope-verification",
    ...result
  })}\n`);
  if (!result.valid) process.exitCode = CLI_EXIT_CODES.runtimeError;
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseCliArgs(argv);
  switch (options.command) {
    case "help":
      process.stdout.write(`${help}\n`);
      return;
    case "version":
      process.stdout.write(`${HARNESS_VERSION}\n`);
      return;
    case "providers":
      listProviders(options.json);
      return;
    case "doctor":
      await doctor(options);
      return;
    case "chat":
      await chat(options);
      return;
    case "resume":
      await resumeRun(options);
      return;
    case "runs":
      await manageRuns(options);
      return;
    case "sessions":
      await manageSessions(options);
      return;
    case "changes":
      await manageChanges(options);
      return;
    case "run":
      if (options.implicitCommand && !options.prompt && process.stdin.isTTY && process.stdout.isTTY) {
        await chat(options);
        return;
      }
      await runOnce(options);
      return;
    case "review":
      await reviewOnce(options);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = cliExitCodeForError(error);
  });
}
