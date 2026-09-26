import { resolveHelpTopic } from "./cli-help.js";
import { z } from "zod";
import { type AgentStatus } from "@zhivex-ai/agents";
import {
  HARNESS_REQUIRED_CAPABILITIES,
  HARNESS_SUBAGENT_PROFILES,
  parseProvider,
  type HarnessSubagentProfile
} from "../runtime/config.js";
import { parseHarnessModelRoute } from "../providers/routing.js";
import { HarnessError } from "../runtime/errors.js";
import { CLI_OPTION_DEFINITIONS, validateCliCommandOptions, type CliCommandOptionContractKey } from "./cli-options.js";
import { validateCliProfileName } from "./cli-profiles.js";

export const CLI_COMMANDS = ["init", "run", "review", "chat", "providers", "doctor", "resume", "runs", "sessions", "changes", "state", "help", "version"] as const;

export const CLI_RUNS_COMMANDS = ["list", "inspect", "cancel", "cleanup", "export"] as const;

export const CLI_SESSIONS_COMMANDS = ["list", "inspect", "rename", "fork", "archive"] as const;

export const CLI_CHANGES_COMMANDS = ["create", "verify"] as const;

export const CLI_STATE_COMMANDS = ["status", "export", "import"] as const;

type Command = (typeof CLI_COMMANDS)[number];

type RunsCommand = (typeof CLI_RUNS_COMMANDS)[number];

type SessionsCommand = (typeof CLI_SESSIONS_COMMANDS)[number];

type ChangesCommand = (typeof CLI_CHANGES_COMMANDS)[number];

type StateCommand = (typeof CLI_STATE_COMMANDS)[number];

export interface CliOptions {
  compactionModel?: string;
  compactionProvider?: string;
  serviceFile?: string;
  command: Command;
  helpTopic?: string;
  profile?: string;
  updateProfile?: boolean;
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
  unlimitedTokens?: boolean;
  compactionMaxEstimatedInputTokens?: number;
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
  requireVerifiedDelivery?: boolean;
  ociRuntime?: string;
  ociImage?: string;
  ociAllowedCommands?: string[];
  ociShellMode?: string;
  ociMaxProcessRuntimeMs?: number;
  ociMaxProcessOutputBytes?: number;
  ociMaxMemoryMb?: number;
  ociMaxPids?: number;
  ociMaxCpus?: number;
  ociMaxWorkspaceBytes?: number;
  ociMaxFileWriteBytes?: number;
  ociTmpfsMb?: number;
  mcpConfigPath?: string;
  contextConfigPath?: string;
  projectContext?: boolean;
  prompt?: string;
  runId?: string;
  idempotencyKey?: string;
  runsCommand?: RunsCommand;
  sessionsCommand?: SessionsCommand;
  changesCommand?: ChangesCommand;
  stateCommand?: StateCommand;
  artifactPath?: string;
  patchPath?: string;
  preconditionsPath?: string;
  verificationTime?: string;
  backupPath?: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionSearch?: string;
  pricingFile?: string;
  usageLimitUsd?: number;
  continueSession: boolean;
  implicitCommand: boolean;
  statuses?: AgentStatus[];
  limit?: number;
  cursor?: string;
  before?: number;
  reason?: string;
  cascade: boolean;
  final: boolean;
  apply: boolean;
  yes: boolean;
  approvalMode?: "ask" | "auto" | "restricted";
  approve?: boolean;
  json: boolean;
  jsonl: boolean;
}

const COMMANDS = new Set<Command>(CLI_COMMANDS);

const RUNS_COMMANDS = new Set<RunsCommand>(CLI_RUNS_COMMANDS);

const SESSIONS_COMMANDS = new Set<SessionsCommand>(CLI_SESSIONS_COMMANDS);

const CHANGES_COMMANDS = new Set<ChangesCommand>(CLI_CHANGES_COMMANDS);

const STATE_COMMANDS = new Set<StateCommand>(CLI_STATE_COMMANDS);

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

export class CliUsageError extends HarnessError {
  constructor(message: string) {
    super(message, { code: "CLI_USAGE_INVALID", category: "usage" });
    this.name = "CliUsageError";
  }
}

const optionValue = (argv: string[], index: number, name: string) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${name}.`);
  }
  return value;
};

export const parseCliArgs = (argv: string[]): CliOptions => {
  const booleanOptions = new Set(["--token-budget", "--no-token-budget", "--yes", "--approve", "--deny", "--json", "--jsonl", "--continue", "--cascade", "--final", "--apply", "--help", "--version", "--no-project-context", "--update"]);
  // Support shell-style --name=value without interpreting text after --.
  const separator = argv.indexOf("--");
  argv = argv.flatMap((arg, index) => {
    const equals = arg.indexOf("=");
    const name = arg.slice(0, equals);
    return (separator < 0 || index < separator) && equals > 0 &&
      name in CLI_OPTION_DEFINITIONS && !booleanOptions.has(name)
      ? [name, arg.slice(equals + 1)] : [arg];
  });
  let command: Command = "run";
  let commandWasExplicit = false;
  const positional: string[] = [];
  const options: CliOptions = {
    command,
    cascade: false,
    final: false,
    apply: false,
    yes: false,
    json: false,
    jsonl: false,
    continueSession: false,
    implicitCommand: true
  };
  let positionalOnly = false;
  const optionCounts = new Map<string, number>();

  // Appending --help to a failing invocation must not validate its runtime inputs.
  const helpIndex = argv.findIndex((arg, index) => (arg === "--help" || arg === "-h") &&
    (argv.indexOf("--") < 0 || index < argv.indexOf("--")));
  if (helpIndex >= 0) {
    const words: string[] = [];
    for (let index = 0; index < argv.length && argv[index] !== "--"; index++) {
      const arg = argv[index]!;
      if (arg.startsWith("-")) {
        if (arg in CLI_OPTION_DEFINITIONS && !booleanOptions.has(arg) &&
            argv[index + 1] && !argv[index + 1]!.startsWith("-")) index++;
      } else words.push(arg);
    }
    const first = words[0];
    const parts = first === "help" ? words.slice(1) :
      first && COMMANDS.has(first as Command)
        ? words.slice(0, ["runs", "sessions", "changes", "state"].includes(first) ? 2 : 1) : [];
    try {
      const topic = resolveHelpTopic(parts, parts.length > 0);
      return { ...options, command: "help", ...(topic ? { helpTopic: topic } : {}) };
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
  }

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
    const canonicalOption = argument === "-h"
      ? "--help"
      : argument === "-v"
        ? "--version"
        : argument;
    if (canonicalOption in CLI_OPTION_DEFINITIONS) {
      optionCounts.set(canonicalOption, (optionCounts.get(canonicalOption) ?? 0) + 1);
    }
    if (!commandWasExplicit && COMMANDS.has(argument as Command)) {
      command = argument as Command;
      options.command = command;
      commandWasExplicit = true;
      continue;
    }

    switch (argument) {
      case "--update":
        options.updateProfile = true;
        break;
      case "-":
        positional.push(argument);
        break;
      case "--profile":
        try {
          options.profile = validateCliProfileName(optionValue(argv, index, argument));
        } catch (error) {
          throw new CliUsageError(error instanceof Error ? error.message : String(error));
        }
        index += 1;
        break;
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
      case "--context-config":
        options.contextConfigPath = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--token-budget":
        options.unlimitedTokens = false;
        break;
      case "--no-token-budget":
        options.unlimitedTokens = true;
        break;
      case "--no-project-context":
        options.projectContext = false;
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
      case "--require-verified-delivery":
        options.requireVerifiedDelivery = true;
        break;
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
      case "--oci-shell":
        options.ociShellMode = optionValue(argv, index, argument);
        if (!["deny", "ask"].includes(options.ociShellMode)) {
          throw new CliUsageError("--oci-shell must be deny or ask.");
        }
        index += 1;
        break;
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
        if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) {
          throw new CliUsageError("--max-steps must be a positive safe integer.");
        }
        index += 1;
        break;
      }
      case "--timeout-ms":
      case "--max-tool-calls":
      case "--max-tool-errors":
      case "--context-tokens":
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
        if (argument === "--context-tokens") options.compactionMaxEstimatedInputTokens = value;
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
      case "--search":
        options.sessionSearch = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--pricing-file":
        options.pricingFile = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--compaction-model":
        options.compactionModel = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--compaction-provider":
        options.compactionProvider = parseProvider(optionValue(argv, index, argument));
        index += 1;
        break;
      case "--usage-limit-usd": {
        const value = Number(optionValue(argv, index, argument));
        if (!Number.isFinite(value) || value <= 0) throw new CliUsageError("--usage-limit-usd must be positive USD.");
        options.usageLimitUsd = value;
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
      case "--approval-mode": {
        const mode = optionValue(argv, index, argument);
        if (mode !== "ask" && mode !== "auto" && mode !== "restricted") throw new CliUsageError("--approval-mode must be ask, auto or restricted.");
        options.approvalMode = mode;
        options.yes = mode === "auto";
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
      case "--service":
        options.serviceFile = optionValue(argv, index, argument);
        index += 1;
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
      case "--apply":
        options.apply = true;
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

  if (options.command === "help") {
    try {
      validateCliCommandOptions("help", optionCounts);
      const topic = resolveHelpTopic(command === "help" ? positional : [command, ...positional], commandWasExplicit);
      if (topic) options.helpTopic = topic;
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
    return options;
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
    if (changesCommand === "create" && (options.preconditionsPath || options.verificationTime)) {
      throw new CliUsageError("--preconditions and --now are only supported by changes verify.");
    }
    if (positional.length > 0) {
      throw new CliUsageError(`changes ${changesCommand} received unexpected positional arguments.`);
    }
  } else if (options.command === "state") {
    const stateCommand = positional.shift() as StateCommand | undefined;
    if (!stateCommand || !STATE_COMMANDS.has(stateCommand)) {
      throw new CliUsageError("state requires one of: status, export, import.");
    }
    options.stateCommand = stateCommand;
    if (stateCommand !== "status") {
      const backupPath = positional.shift();
      if (!backupPath) throw new CliUsageError(`state ${stateCommand} requires a backup JSON path.`);
      options.backupPath = backupPath;
    }
    if (positional.length > 0) {
      throw new CliUsageError(`state ${stateCommand} received unexpected positional arguments.`);
    }
  } else if (options.command === "run" || options.command === "review") {
    if (positional.includes("-") && positional.length !== 1) {
      throw new CliUsageError("Use - alone to read the task from stdin, or provide a task argument.");
    }
    const prompt = positional.join(" ").trim();
    if (prompt) {
      options.prompt = prompt;
    }
  } else if (positional.length > 0) {
    throw new CliUsageError(`${options.command} does not accept positional arguments.`);
  }

  if (options.implicitCommand && options.command === "run" && !options.prompt &&
      (options.continueSession || options.sessionId) && !options.json && !options.jsonl) options.command = "chat";

  if (options.serviceFile) {
    const allowed = new Set(["--service", "--session", "--idempotency-key", "--yes", "--json", "--jsonl", "--approve", "--deny", "--search", "--continue"]);
    for (const arg of optionCounts.keys()) if (arg.startsWith("--") && !allowed.has(arg)) throw new CliUsageError(`Service mode does not accept ${arg}; runtime configuration belongs to the service host.`);
  } else if (["run", "resume"].includes(options.command) && optionCounts.has("--session")) {
    throw new CliUsageError("--session for run/resume requires --service.");
  }

  const commandKey = options.command === "runs"
    ? `runs:${options.runsCommand}`
    : options.command === "sessions"
      ? `sessions:${options.sessionsCommand}`
      : options.command === "changes"
        ? `changes:${options.changesCommand}`
        : options.command === "state"
          ? `state:${options.stateCommand}`
        : options.command;
  try {
    validateCliCommandOptions(commandKey as CliCommandOptionContractKey, optionCounts);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  if (options.command === "review") {
    const invalidRoute = options.routes
      ?.map((route) => parseHarnessModelRoute(route))
      .find((route) => route.profile !== "explorer" && route.profile !== "reviewer");
    if (invalidRoute) {
      throw new CliUsageError(
        `review cannot route the unused ${invalidRoute.profile} profile; use explorer or reviewer.`
      );
    }
  }

  return options;
};
