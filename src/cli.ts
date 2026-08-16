#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentApprovalRequest, AgentApprovalResponse, AgentRunOutput, AgentStreamEvent } from "@zhivex-ai/agents";
import { createFileAgentRunStore } from "@zhivex-ai/agents/ops";

import { parseProvider, providerAvailability, resolveHarnessConfig, type HarnessProvider } from "./config.js";
import { appendUserMessage, createHarness, runHarness, type HarnessRunOptions, type ZhivexHarness } from "./harness.js";
import { BUN_ENGINE_RANGE, HARNESS_VERSION } from "./version.js";

export const CLI_JSON_SCHEMA_VERSION = 1 as const;

export const CLI_EXIT_CODES = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
  doctorFailed: 3
} as const;

type Command = "run" | "chat" | "providers" | "doctor" | "resume" | "help" | "version";

export interface CliOptions {
  command: Command;
  provider?: string;
  model?: string;
  workspace?: string;
  stateDirectory?: string;
  maxSteps?: number;
  allowedChecks?: string[];
  prompt?: string;
  runId?: string;
  yes: boolean;
  approve?: boolean;
  json: boolean;
}

const COMMANDS = new Set<Command>(["run", "chat", "providers", "doctor", "resume", "help", "version"]);

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
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
  let command: Command = "run";
  let commandWasExplicit = false;
  const positional: string[] = [];
  const options: CliOptions = { command, yes: false, json: false };
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
      case "--workspace":
        options.workspace = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--state-dir":
        options.stateDirectory = optionValue(argv, index, argument);
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

  if (options.command === "resume") {
    const runId = positional.shift();
    if (runId) {
      options.runId = runId;
    }
    if (positional.length > 0) {
      throw new CliUsageError("resume accepts exactly one runId.");
    }
  } else if (options.command === "run") {
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
  zhivex-harness run [options] "task"
  zhivex-harness chat [options]
  zhivex-harness providers [--json]
  zhivex-harness doctor [options] [--json]
  zhivex-harness resume [options] <runId> --approve|--deny

Options:
  --provider <meta|qwen|openai>  Provider (default: openai)
  --model <id>                   Override the default model
  --workspace <path>             Target workspace (default: cwd)
  --state-dir <path>             Durable run-state directory
  --max-steps <1-50>             Maximum agent steps (default: 12)
  --allow-check <script>         Allow one package.json script; repeatable
  --yes                          Automatically approve writes and checks
  --json                         Emit structured final output
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
  Qwen:   DASHSCOPE_API_KEY or QWEN_API_KEY`;

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
    arguments: approval.arguments
  })),
  usage: result.usage,
  stateDirectory: harness.config.stateDirectory
});

const printTerminalResult = (result: AgentRunOutput, harness: ZhivexHarness, json: boolean, streamedText: boolean) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(runResultDocument(result, harness), null, 2)}\n`);
    return;
  }
  if (!streamedText && result.outputText) {
    process.stdout.write(result.outputText);
  }
  if (result.outputText || streamedText) {
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
      `The state was persisted. Resume with: zhivex-harness resume ${result.state.runId} --approve\n`
    );
  }
};

const streamSink = (json: boolean, tracker: { streamedText: boolean }) => async (event: AgentStreamEvent) => {
  if (!json && event.type === "text-delta") {
    tracker.streamedText = true;
    process.stdout.write(event.textDelta);
  }
};

const runOnce = async (options: CliOptions) => {
  if (!options.prompt) {
    throw new CliUsageError("Missing task. Example: zhivex-harness run \"fix the tests\".");
  }
  const harness = await createHarness(options);
  const tracker = { streamedText: false };
  const result = await runHarness(
    harness,
    { prompt: options.prompt },
    {
      onEvent: streamSink(options.json, tracker),
      resolveApprovals: terminalApprovalResolver(options.yes)
    }
  );
  printTerminalResult(result, harness, options.json, tracker.streamedText);
  if (result.status === "failed" || result.status === "timed_out") {
    process.exitCode = CLI_EXIT_CODES.runtimeError;
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
  const store = createFileAgentRunStore({ directory: initialConfig.stateDirectory });
  const state = await store.load(options.runId);
  if (!state) {
    throw new Error(`Run ${options.runId} was not found in ${initialConfig.stateDirectory}.`);
  }
  if (state.status !== "waiting_approval" || state.pendingApprovals.length === 0) {
    throw new Error(`Run ${options.runId} is not waiting for approval (status: ${state.status}).`);
  }

  for (const approval of state.pendingApprovals) {
    process.stderr.write(`\nResuming approval:\n${summarizeApproval(approval)}\n`);
  }

  const harness = await createHarness({
    ...options,
    provider: state.provider as HarnessProvider,
    model: state.modelId,
    store
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
      onEvent: streamSink(options.json, tracker),
      resolveApprovals: async (approvals) => approvalResponses(
        approvals,
        approve,
        approve ? "Approved by resume --approve." : "Denied by resume --deny."
      )
    }
  );
  printTerminalResult(result, harness, options.json, tracker.streamedText);
  if (result.status === "failed" || result.status === "timed_out") {
    process.exitCode = CLI_EXIT_CODES.runtimeError;
  }
};

const chat = async (options: CliOptions) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Chat mode requires an interactive terminal. Use run for automation.");
  }
  const harness = await createHarness(options);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let messages: AgentRunOutput["messages"] = [];

  process.stderr.write(
    `Zhivex Harness ${HARNESS_VERSION} · ${harness.config.provider}/${harness.config.model}\n` +
    "Type /exit to quit or /clear to clear the context.\n"
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
      if (prompt === "/clear") {
        messages = [];
        process.stderr.write("Context cleared.\n");
        continue;
      }

      const tracker = { streamedText: false };
      const result = await runHarness(
        harness,
        messages.length === 0 ? { prompt } : { messages: appendUserMessage(messages, prompt) },
        {
          onEvent: streamSink(false, tracker),
          resolveApprovals: terminalApprovalResolver(options.yes, (question) => readline.question(question))
        }
      );
      if (!tracker.streamedText && result.outputText) {
        process.stdout.write(result.outputText);
      }
      process.stdout.write("\n");
      messages = result.messages;
      if (result.status === "waiting_approval") {
        process.stderr.write(`Run paused: ${result.state.runId}\n`);
      }
    }
  } finally {
    readline.close();
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
    maxSteps: number;
    allowedChecks: readonly string[];
  };
  checks: DoctorCheck[];
  providers: ReturnType<typeof providerAvailability>;
}

export interface DoctorContext {
  env?: NodeJS.ProcessEnv;
  bunVersion?: string;
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

export const createDoctorReport = async (
  options: Pick<CliOptions, "provider" | "model" | "workspace" | "stateDirectory" | "maxSteps" | "allowedChecks"> = {},
  context: DoctorContext = {}
): Promise<DoctorReport> => {
  const env = context.env ?? process.env;
  const config = resolveHarnessConfig({
    ...(env.ZHIVEX_HARNESS_PROVIDER ? { provider: env.ZHIVEX_HARNESS_PROVIDER } : {}),
    ...(env.ZHIVEX_HARNESS_MODEL ? { model: env.ZHIVEX_HARNESS_MODEL } : {}),
    ...(env.ZHIVEX_HARNESS_MAX_STEPS
      ? { maxSteps: Number(env.ZHIVEX_HARNESS_MAX_STEPS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_ALLOWED_CHECKS !== undefined
      ? { allowedChecks: env.ZHIVEX_HARNESS_ALLOWED_CHECKS.split(",") }
      : {}),
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
      maxSteps: config.maxSteps,
      allowedChecks: config.allowedChecks
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

export const cliExitCodeForError = (error: unknown) =>
  error instanceof CliUsageError ? CLI_EXIT_CODES.usageError : CLI_EXIT_CODES.runtimeError;

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
    case "run":
      await runOnce(options);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = cliExitCodeForError(error);
  });
}
