import { lstat } from "node:fs/promises";
import path from "node:path";

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
import {
  createEditProposal,
  editContractDocument,
  editProposalInputSchema,
  applyEditProposalInputSchema,
  moveFileInputSchema,
  quarantineFileInputSchema,
  restoreFileInputSchema,
  validateEditProposal,
  type EditChange
} from "./edit-contracts.js";
import { Workspace } from "./workspace.js";
import { HARNESS_VERSION } from "./version.js";

const APPROVAL_VERSION = "2026-08-16-v2";
const SENSITIVE_STATE_SEGMENTS = new Set([".git", ".env", ".npmrc", "dist", "node_modules", "src"]);

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const validateStateDirectory = async (workspace: string, stateDirectory: string) => {
  if (stateDirectory === workspace || stateDirectory === path.parse(stateDirectory).root) {
    throw new Error("The state directory cannot be the workspace or filesystem root.");
  }

  const insideWorkspace = isInside(workspace, stateDirectory);
  const relativeSegments = insideWorkspace
    ? path.relative(workspace, stateDirectory).split(path.sep).filter(Boolean)
    : stateDirectory.slice(path.parse(stateDirectory).root.length).split(path.sep).filter(Boolean);
  const sensitiveSegment = insideWorkspace
    ? relativeSegments.find((segment) => SENSITIVE_STATE_SEGMENTS.has(segment))
    : undefined;
  if (sensitiveSegment) {
    throw new Error(`The state directory is inside the protected workspace path: ${sensitiveSegment}.`);
  }

  if (!insideWorkspace) {
    try {
      const externalEntry = await lstat(stateDirectory);
      if (externalEntry.isSymbolicLink()) {
        throw new Error(`The state directory must not be a symbolic link: ${stateDirectory}.`);
      }
      if (!externalEntry.isDirectory()) {
        throw new Error(`The state directory is not a directory: ${stateDirectory}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  let current = workspace;
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`The state directory must not resolve through a symbolic link: ${current}.`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`The state directory path contains a non-directory entry: ${current}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
};

export const HARNESS_INSTRUCTIONS = `You are Zhivex Harness, a provider-portable coding agent operating inside one workspace.

Rules:
- Match the user's language.
- Inspect the repository before proposing changes. Prefer search_files and read_file over assumptions.
- Use only workspace-relative paths. Never request or expose secrets.
- Make the smallest coherent change that fully addresses the task.
- For every file edit, first read its digest and call propose_edits. Apply exactly that reviewed proposal with apply_patch.
- apply_patch, move_file, quarantine_file, restore_file, and run_check require explicit approval from the operator.
- Never overwrite stale content. If an expected digest no longer matches, inspect the file again and create a new proposal.
- Deletions are recoverable: use quarantine_file, never permanent deletion. Use restore_file to recover quarantined content.
- Never claim a check passed unless run_check returned exitCode 0.
- Before finishing, inspect git_diff and mutation_audit. Summarize every mutation, the final diff, validation performed, and any remaining risk.
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

const verifyEditPreconditions = async (workspace: Workspace, changes: readonly EditChange[]) => {
  for (const change of changes) {
    try {
      const current = await workspace.readFile(change.path, 1, 1);
      if (change.expectedDigest === null) {
        throw new Error(`Cannot propose creating ${change.path}: the file already exists.`);
      }
      if (current.digest !== change.expectedDigest) {
        throw new Error(
          `Cannot propose editing ${change.path}: expectedDigest does not match the current file.`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && change.expectedDigest === null) {
        continue;
      }
      throw error;
    }
  }
};

const mutationApproval = {
  requiresApproval: true,
  approvalMode: "interrupt" as const,
  approvalVersion: APPROVAL_VERSION,
  metadata: { permissions: ["filesystem", "write"], risk: "high" }
};

const createWorkspaceTools = (workspace: Workspace, allowedChecks: readonly string[]) => ({
  list_files: tool({
    name: "list_files",
    description: "List regular files with content digests using a stable cursor. Build artifacts, dependencies, Git internals, and harness state are ignored.",
    schema: z.object({
      path: z.string().min(1).default("."),
      limit: z.number().int().min(1).max(500).default(200),
      cursor: z.string().min(1).max(2000).optional()
    }),
    execute: async ({ path, limit, cursor }) => serializeJsonValue(await workspace.listFiles(path, {
      limit,
      ...(cursor ? { cursor } : {})
    }))
  }),
  read_file: tool({
    name: "read_file",
    description: "Read a bounded, line-numbered slice and SHA-256 digest of one UTF-8 text file using a workspace-relative path.",
    schema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).default(1),
      endLine: z.number().int().min(1).optional()
    }),
    execute: async ({ path, startLine, endLine }) => serializeJsonValue(await workspace.readFile(path, startLine, endLine))
  }),
  search_files: tool({
    name: "search_files",
    description: "Search for a literal string in text files using a stable cursor.",
    schema: z.object({
      query: z.string().min(1).max(200),
      path: z.string().min(1).default("."),
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().min(1).max(2000).optional()
    }),
    execute: async ({ query, path, caseSensitive, limit, cursor }) =>
      serializeJsonValue(await workspace.searchFiles(query, path, {
        caseSensitive,
        limit,
        ...(cursor ? { cursor } : {})
      }))
  }),
  propose_edits: tool({
    name: "propose_edits",
    description: "Validate a bounded multi-file edit against current SHA-256 digests and return a deterministic proposalId for operator review. This tool does not write files.",
    schema: editProposalInputSchema,
    execute: async ({ changes }) => {
      await verifyEditPreconditions(workspace, changes);
      return serializeJsonValue(createEditProposal({ changes }));
    }
  }),
  apply_patch: tool({
    name: "apply_patch",
    description: "Atomically apply one reviewed multi-file proposal. Every existing file requires its exact expected digest; expectedDigest=null is create-only.",
    schema: applyEditProposalInputSchema,
    ...mutationApproval,
    execute: async (input) => {
      const proposal = validateEditProposal(input);
      return serializeJsonValue(editContractDocument("patch-result", await workspace.applyPatch(proposal)));
    }
  }),
  move_file: tool({
    name: "move_file",
    description: "Move one regular file without overwriting the destination. The source must still match expectedDigest.",
    schema: moveFileInputSchema,
    ...mutationApproval,
    execute: async (input) => serializeJsonValue(editContractDocument("move-result", await workspace.moveFile(input)))
  }),
  quarantine_file: tool({
    name: "quarantine_file",
    description: "Recoverably remove one regular file into harness-owned quarantine after verifying expectedDigest. Permanent deletion is unavailable.",
    schema: quarantineFileInputSchema,
    ...mutationApproval,
    execute: async (input) => serializeJsonValue(editContractDocument(
      "quarantine-result",
      await workspace.quarantineFile(input)
    ))
  }),
  restore_file: tool({
    name: "restore_file",
    description: "Restore a quarantined file to its original path or an explicit safe destination without overwriting content unexpectedly.",
    schema: restoreFileInputSchema,
    ...mutationApproval,
    execute: async (input) => serializeJsonValue(editContractDocument(
      "restore-result",
      await workspace.restoreQuarantined(input)
    ))
  }),
  run_check: tool({
    name: "run_check",
    description: `Run one explicitly allowed package.json script through Bun (${allowedChecks.join(", ")}). Read package.json first and pass its exact script text as expectedScript so the operator can review the command. No arbitrary shell or .env loading is exposed.`,
    schema: z.object({
      check: z.string().min(1).max(100).regex(/^[A-Za-z0-9:_-]+$/),
      expectedScript: z.string().min(1).max(2000)
    }),
    requiresApproval: true,
    approvalMode: "interrupt",
    approvalVersion: APPROVAL_VERSION,
    metadata: { permissions: ["code-execution"], risk: "high" },
    execute: async ({ check, expectedScript }) =>
      serializeJsonValue(await workspace.runCheck(check, expectedScript, allowedChecks))
  }),
  mutation_audit: tool({
    name: "mutation_audit",
    description: "Inspect the immutable in-memory audit journal for file mutations made by this harness instance.",
    schema: z.object({}),
    execute: async () => serializeJsonValue(editContractDocument("mutation-audit", workspace.mutationAudit()))
  }),
  git_diff: tool({
    name: "git_diff",
    description: "Inspect final Git status, unstaged diff, staged diff, and this harness instance's mutation audit. This tool is read-only and does not commit, stage, reset, or push.",
    schema: z.object({}),
    execute: async () => serializeJsonValue(editContractDocument("workspace-diff", {
      ...(await workspace.gitDiff()),
      mutations: workspace.mutationAudit()
    }))
  })
});

export const createHarness = async (options: CreateHarnessOptions = {}): Promise<ZhivexHarness> => {
  const config = resolveHarnessConfig(options);
  const workspace = await Workspace.open(config.workspace);
  await validateStateDirectory(config.workspace, config.stateDirectory);
  const model = options.modelInstance ?? createProviderModel(config, options.env ?? process.env);
  const store = options.store ?? createFileAgentRunStore({ directory: config.stateDirectory });

  const agent = new Agent<LanguageModel>({
    id: `zhivex-harness-${config.provider}`,
    model,
    instructions: HARNESS_INSTRUCTIONS,
    maxSteps: config.maxSteps,
    tools: createWorkspaceTools(workspace, config.allowedChecks),
    policy: {
      timeoutMs: 15 * 60_000
    },
    metadata: {
      harnessVersion: HARNESS_VERSION,
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
