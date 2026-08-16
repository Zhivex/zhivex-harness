import { Agent, tool, type AgentApprovalRequest, type AgentApprovalResponse, type AgentRunInput, type AgentRunOutput, type AgentStreamEvent, type LanguageModel } from "@zhivex-ai/agents";
import { createFileAgentRunStore, type AgentRunStore } from "@zhivex-ai/agents/ops";
import { serializeJsonValue, type ModelMessage } from "@zhivex-ai/core";
import { z } from "zod";

import {
  createProviderModel,
  resolveHarnessConfig,
  type HarnessConfig,
  type HarnessConfigInput
} from "./config.js";
import { Workspace, type HarnessCheck } from "./workspace.js";

const APPROVAL_VERSION = "2026-08-16-v1";

export const HARNESS_INSTRUCTIONS = `You are Zhivex Harness, a provider-portable coding agent operating inside one workspace.

Rules:
- Match the user's language.
- Inspect the repository before proposing changes. Prefer search_files and read_file over assumptions.
- Use only workspace-relative paths. Never request or expose secrets.
- Make the smallest coherent change that fully addresses the task.
- write_file, replace_in_file, and run_check require explicit approval from the operator.
- Never claim a check passed unless run_check returned exitCode 0.
- Before finishing, inspect git_diff. Summarize changed files, validation performed, and any remaining risk.
- If a requested action is unavailable, explain the boundary instead of fabricating execution.`;

export interface CreateHarnessOptions extends HarnessConfigInput {
  env?: NodeJS.ProcessEnv;
  modelInstance?: LanguageModel;
  store?: AgentRunStore;
}

export interface ZhivexHarness {
  config: HarnessConfig;
  workspace: Workspace;
  agent: Agent<LanguageModel>;
}

export interface HarnessRunOptions {
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  resolveApprovals?: (
    approvals: readonly AgentApprovalRequest[],
    state: AgentRunOutput["state"]
  ) => Promise<readonly AgentApprovalResponse[] | undefined>;
}

const createWorkspaceTools = (workspace: Workspace) => ({
  list_files: tool({
    name: "list_files",
    description: "List regular files under a workspace-relative directory. Build artifacts, dependencies, Git internals, and harness state are ignored.",
    schema: z.object({
      path: z.string().min(1).default("."),
      maxEntries: z.number().int().min(1).max(500).default(200)
    }),
    execute: async ({ path, maxEntries }) => serializeJsonValue(await workspace.listFiles(path, maxEntries))
  }),
  read_file: tool({
    name: "read_file",
    description: "Read a bounded, line-numbered slice of one UTF-8 text file using a workspace-relative path.",
    schema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).default(1),
      endLine: z.number().int().min(1).optional()
    }),
    execute: async ({ path, startLine, endLine }) => serializeJsonValue(await workspace.readFile(path, startLine, endLine))
  }),
  search_files: tool({
    name: "search_files",
    description: "Search for a literal string in text files within the workspace.",
    schema: z.object({
      query: z.string().min(1).max(200),
      path: z.string().min(1).default("."),
      caseSensitive: z.boolean().default(false),
      maxMatches: z.number().int().min(1).max(500).default(100)
    }),
    execute: async ({ query, path, caseSensitive, maxMatches }) =>
      serializeJsonValue(await workspace.searchFiles(query, path, { caseSensitive, maxMatches }))
  }),
  write_file: tool({
    name: "write_file",
    description: "Create a UTF-8 text file, or overwrite it only when overwrite=true. Requires operator approval.",
    schema: z.object({
      path: z.string().min(1),
      content: z.string().max(1024 * 1024),
      overwrite: z.boolean().default(false)
    }),
    requiresApproval: true,
    approvalMode: "interrupt",
    approvalVersion: APPROVAL_VERSION,
    metadata: { permissions: ["filesystem", "write"], risk: "high" },
    execute: async ({ path, content, overwrite }) => serializeJsonValue(await workspace.writeFile(path, content, overwrite))
  }),
  replace_in_file: tool({
    name: "replace_in_file",
    description: "Replace one exact, uniquely occurring text fragment in an existing UTF-8 file. Requires operator approval.",
    schema: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1).max(1024 * 1024),
      newText: z.string().max(1024 * 1024)
    }),
    requiresApproval: true,
    approvalMode: "interrupt",
    approvalVersion: APPROVAL_VERSION,
    metadata: { permissions: ["filesystem", "write"], risk: "high" },
    execute: async ({ path, oldText, newText }) => serializeJsonValue(await workspace.replaceInFile(path, oldText, newText))
  }),
  run_check: tool({
    name: "run_check",
    description: "Run one package.json script through Bun: test, typecheck, lint, or build. Read package.json first and pass its exact script text as expectedScript so the operator can review the command. No arbitrary shell or .env loading is exposed. Requires operator approval.",
    schema: z.object({
      check: z.enum(["test", "typecheck", "lint", "build"]),
      expectedScript: z.string().min(1).max(2000)
    }),
    requiresApproval: true,
    approvalMode: "interrupt",
    approvalVersion: APPROVAL_VERSION,
    metadata: { permissions: ["code-execution"], risk: "high" },
    execute: async ({ check, expectedScript }) =>
      serializeJsonValue(await workspace.runCheck(check as HarnessCheck, expectedScript))
  }),
  git_diff: tool({
    name: "git_diff",
    description: "Inspect Git status and the unstaged diff. This tool is read-only and does not commit, stage, reset, or push.",
    schema: z.object({}),
    execute: async () => serializeJsonValue(await workspace.gitDiff())
  })
});

export const createHarness = async (options: CreateHarnessOptions = {}): Promise<ZhivexHarness> => {
  const config = resolveHarnessConfig(options);
  const workspace = await Workspace.open(config.workspace);
  const model = options.modelInstance ?? createProviderModel(config, options.env ?? process.env);
  const store = options.store ?? createFileAgentRunStore({ directory: config.stateDirectory });

  const agent = new Agent<LanguageModel>({
    id: `zhivex-harness-${config.provider}`,
    model,
    instructions: HARNESS_INSTRUCTIONS,
    maxSteps: config.maxSteps,
    tools: createWorkspaceTools(workspace),
    policy: {
      timeoutMs: 15 * 60_000
    },
    metadata: {
      harnessVersion: "0.1.0",
      provider: config.provider,
      model: config.model
    },
    store
  });

  return { config, workspace, agent };
};

export const runHarness = async (
  harness: ZhivexHarness,
  input: AgentRunInput<LanguageModel>,
  options: HarnessRunOptions = {}
): Promise<AgentRunOutput> => {
  let nextInput = input;

  for (let approvalRound = 0; approvalRound < 50; approvalRound += 1) {
    const streamed = harness.agent.stream(nextInput);
    for await (const event of streamed.eventStream) {
      await options.onEvent?.(event);
    }
    const result = await streamed.collect();

    if (result.status !== "waiting_approval" || result.state.pendingApprovals.length === 0) {
      return result;
    }

    const approvals = await options.resolveApprovals?.(result.state.pendingApprovals, result.state);
    if (!approvals) {
      return result;
    }

    nextInput = {
      state: result.state,
      approvals: [...approvals]
    };
  }

  throw new Error("The run exceeded the limit of 50 approval rounds.");
};

export const appendUserMessage = (messages: readonly ModelMessage[], text: string): ModelMessage[] => [
  ...messages,
  {
    role: "user",
    parts: [{ type: "text", text }]
  }
];
