#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";

import type { AgentApprovalRequest, AgentApprovalResponse, AgentRunOutput, AgentStreamEvent } from "@zhivex-ai/agents";
import { createFileAgentRunStore } from "@zhivex-ai/agents/ops";

import { providerAvailability, resolveHarnessConfig, type HarnessProvider } from "./config.js";
import { appendUserMessage, createHarness, runHarness, type HarnessRunOptions, type ZhivexHarness } from "./harness.js";

const VERSION = "0.1.0";

type Command = "run" | "chat" | "providers" | "resume" | "help" | "version";

export interface CliOptions {
  command: Command;
  provider?: string;
  model?: string;
  workspace?: string;
  stateDirectory?: string;
  maxSteps?: number;
  prompt?: string;
  runId?: string;
  yes: boolean;
  approve?: boolean;
  json: boolean;
}

const COMMANDS = new Set<Command>(["run", "chat", "providers", "resume", "help", "version"]);

const optionValue = (argv: string[], index: number, name: string) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
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
        options.provider = optionValue(argv, index, argument);
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
        index += 1;
        break;
      }
      case "--yes":
        options.yes = true;
        break;
      case "--approve":
        if (options.approve === false) {
          throw new Error("You cannot combine --approve and --deny.");
        }
        options.approve = true;
        break;
      case "--deny":
        if (options.approve === true) {
          throw new Error("You cannot combine --approve and --deny.");
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
          throw new Error(`Unknown option: ${argument}`);
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
      throw new Error("resume accepts exactly one runId.");
    }
  } else if (options.command === "run") {
    const prompt = positional.join(" ").trim();
    if (prompt) {
      options.prompt = prompt;
    }
  } else if (positional.length > 0) {
    throw new Error(`${options.command} does not accept positional arguments.`);
  }

  return options;
};

const help = `Zhivex Harness v${VERSION}

Usage:
  zhivex-harness run [options] "task"
  zhivex-harness chat [options]
  zhivex-harness providers [--json]
  zhivex-harness resume [options] <runId> --approve|--deny

Options:
  --provider <meta|qwen|openai>  Provider (default: openai)
  --model <id>                   Override the default model
  --workspace <path>             Target workspace (default: cwd)
  --state-dir <path>             Durable run-state directory
  --max-steps <1-50>             Maximum agent steps (default: 12)
  --yes                          Automatically approve writes and checks
  --json                         Emit structured final output
  -h, --help                     Show this help
  -v, --version                  Show the version

Credentials:
  OpenAI: OPENAI_API_KEY
  Meta:   MODEL_API_KEY
  Qwen:   DASHSCOPE_API_KEY or QWEN_API_KEY`;

const summarizeApproval = (approval: AgentApprovalRequest) => {
  const argumentsText = approval.arguments.length > 1200
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

const resultSummary = (result: AgentRunOutput, harness: ZhivexHarness) => ({
  runId: result.state.runId,
  status: result.status,
  provider: result.state.provider,
  model: result.state.modelId,
  output: result.outputText,
  steps: result.steps.length,
  toolCalls: result.toolResults.length,
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
    process.stdout.write(`${JSON.stringify(resultSummary(result, harness), null, 2)}\n`);
    return;
  }
  if (!streamedText && result.outputText) {
    process.stdout.write(result.outputText);
  }
  if (result.outputText || streamedText) {
    process.stdout.write("\n");
  }
  process.stderr.write(
    `\nrun ${result.state.runId} · ${result.state.provider}/${result.state.modelId} · ${result.status} · ${result.steps.length} steps\n`
  );
  if (result.status === "waiting_approval") {
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
    throw new Error("Missing task. Example: zhivex-harness run \"fix the tests\".");
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
    process.exitCode = 1;
  }
};

const resumeRun = async (options: CliOptions) => {
  if (!options.runId) {
    throw new Error("Missing runId to resume.");
  }
  if (options.approve === undefined) {
    throw new Error("Specify --approve or --deny when resuming.");
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
};

const chat = async (options: CliOptions) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Chat mode requires an interactive terminal. Use run for automation.");
  }
  const harness = await createHarness(options);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let messages: AgentRunOutput["messages"] = [];

  process.stderr.write(
    `Zhivex Harness ${VERSION} · ${harness.config.provider}/${harness.config.model}\n` +
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

const listProviders = (json: boolean) => {
  const providers = providerAvailability();
  if (json) {
    process.stdout.write(`${JSON.stringify(providers, null, 2)}\n`);
    return;
  }
  for (const provider of providers) {
    process.stdout.write(
      `${provider.id.padEnd(7)} ${provider.defaultModel.padEnd(22)} ${provider.configured ? "configured" : `missing ${provider.credentialNames.join("/")}`}\n`
    );
  }
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseCliArgs(argv);
  switch (options.command) {
    case "help":
      process.stdout.write(`${help}\n`);
      return;
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "providers":
      listProviders(options.json);
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
    process.exitCode = 1;
  });
}
