import { dependencyReadSchema, readDependency } from "./dependency-read.js";
import { replacementEditSchema } from "../workspace/replacement-edits.js";
import { tool } from "@zhivex-ai/agents";
import { serializeJsonValue } from "@zhivex-ai/core";
import { z } from "zod";
import {
  createEditProposal,
  editContractDocument,
  editProposalInputSchema,
  applyEditProposalInputSchema,
  moveFileInputSchema,
  quarantineFileInputSchema,
  restoreFileInputSchema,
  validateEditProposal
} from "../workspace/edit-contracts.js";
import { Workspace } from "../workspace/workspace.js";
import { harnessExecutionSession } from "../execution/execution-environment.js";
import {
  APPROVAL_VERSION,
  mutationApproval,
  readOnlyMetadata,
  toolMetadata,
  verifyEditPreconditions
} from "./shared.js";

export const createWorkspaceTools = (workspace: Workspace, allowedChecks: readonly string[]) => ({
  read_dependency: tool({
    name: "read_dependency",
    description: "Inspect one installed dependency's package.json (version and exports) or .d.ts/.d.mts/.d.cts declarations. Requires separate approval. Read-only, bounded, no links or source execution. Ordinary read_file cannot access node_modules.",
    schema: dependencyReadSchema,
    requiresApproval: true,
    approvalMode: "interrupt",
    approvalVersion: APPROVAL_VERSION,
    metadata: readOnlyMetadata,
    execute: async (input, context) => serializeJsonValue(await readDependency(
      (harnessExecutionSession(context)?.workspace ?? workspace).root, input))
  }),
  list_files: tool({
    name: "list_files",
    description: "List regular files using a stable cursor. Omit cursor on the first call; on later pages pass only the exact nextCursor returned by the preceding matching request. Defaults to fast path-only topology; set includeDigests=true when size and content digests are required. Build artifacts, dependencies, Git internals, and harness state are ignored.",
    schema: z.object({
      path: z.string().min(1).default("."),
      limit: z.number().int().min(1).max(500).default(200),
      includeDigests: z.boolean().default(false),
      cursor: z.string().min(1).max(2000).nullable().optional().describe(
        "Use null or omit on the first page. For a later page, pass only the exact nextCursor returned by the preceding matching list_files result. Never invent a cursor."
      )
    }),
    metadata: readOnlyMetadata,
    execute: async ({ path, limit, includeDigests, cursor }, context) => {
      const selectedWorkspace = harnessExecutionSession(context)?.workspace ?? workspace;
      return serializeJsonValue(await (includeDigests
        ? selectedWorkspace.listFiles(path, { limit, includeDigests: true, ...(cursor ? { cursor } : {}) })
        : selectedWorkspace.listFiles(path, { limit, includeDigests: false, ...(cursor ? { cursor } : {}) })));
    }
  }),
  read_file: tool({
    name: "read_file",
    description: "Read a bounded, line-numbered slice and SHA-256 digest of one UTF-8 text file using a workspace-relative path.",
    schema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).default(1),
      endLine: z.number().int().min(1).optional()
    }),
    metadata: readOnlyMetadata,
    execute: async ({ path, startLine, endLine }, context) => serializeJsonValue(await (
      harnessExecutionSession(context)?.workspace ?? workspace
    ).readFile(path, startLine, endLine))
  }),
  read_files: tool({
    name: "read_files",
    description: "Read up to 20 independent UTF-8 file slices in one bounded call. Duplicate paths are read once and results use deterministic path/range order.",
    schema: z.object({
      files: z.array(z.object({
        path: z.string().min(1),
        startLine: z.number().int().min(1).default(1),
        endLine: z.number().int().min(1).optional()
      })).min(1).max(20)
    }),
    metadata: readOnlyMetadata,
    execute: async ({ files }, context) => serializeJsonValue(await (
      harnessExecutionSession(context)?.workspace ?? workspace
    ).readFiles(files.map(({ path, startLine, endLine }) => ({
      path,
      startLine,
      ...(endLine !== undefined ? { endLine } : {})
    }))))
  }),
  search_files: tool({
    name: "search_files",
    description: "Search for a literal string in text files using a stable cursor.",
    schema: z.object({
      query: z.string().min(1).max(200),
      path: z.string().min(1).default("."),
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(10),
      cursor: z.string().min(1).max(2000).nullable().optional().describe("Use null or omit for the first page; otherwise use the exact returned nextCursor.")
    }),
    metadata: readOnlyMetadata,
    execute: async ({ query, path, caseSensitive, limit, cursor }, context) =>
      serializeJsonValue(await (harnessExecutionSession(context)?.workspace ?? workspace).searchFiles(query, path, {
        caseSensitive,
        limit,
        ...(cursor ? { cursor } : {})
      }))
  }),
  search_many: tool({
    name: "search_many",
    description: "Search up to 10 independent literal queries in a single file or directory. Prefer an exact file path once known; directory searches include descendants. At most 500 aggregate matches.",
    schema: z.object({
      queries: z.array(z.object({
        query: z.string().min(1).max(200),
        caseSensitive: z.boolean().default(false)
      })).min(1).max(10),
      path: z.string().min(1).default("."),
      limitPerQuery: z.number().int().min(1).max(500).default(10)
    }).superRefine((input, context) => {
      if (input.queries.length * input.limitPerQuery > 500) {
        context.addIssue({
          code: "custom",
          path: ["limitPerQuery"],
          message: "search_many allows at most 500 aggregate matches."
        });
      }
    }),
    metadata: readOnlyMetadata,
    execute: async ({ queries, path, limitPerQuery }, context) => serializeJsonValue(await (
      harnessExecutionSession(context)?.workspace ?? workspace
    ).searchMany(queries, path, { limitPerQuery }))
  }),
  propose_edits: tool({
    name: "propose_edits",
    description: "Validate a bounded multi-file edit against current SHA-256 digests and return a deterministic proposalId for operator review. This tool does not write files.",
    schema: editProposalInputSchema,
    metadata: readOnlyMetadata,
    execute: async ({ changes }, context) => {
      await verifyEditPreconditions(harnessExecutionSession(context)?.workspace ?? workspace, changes);
      return serializeJsonValue(createEditProposal({ changes }));
    }
  }),
  apply_patch: tool({
    name: "apply_patch",
    description: "Request approval to atomically apply one reviewed multi-file proposal; the runtime pauses before execution. Every existing file requires its exact expected digest; expectedDigest=null is create-only. Call this tool instead of asking for approval in text.",
    schema: applyEditProposalInputSchema,
    ...mutationApproval,
    execute: async (input, context) => {
      const proposal = validateEditProposal(input);
      return serializeJsonValue(editContractDocument(
        "patch-result",
        await (harnessExecutionSession(context)?.workspace ?? workspace).applyPatch(proposal)
      ));
    }
  }),
  apply_reviewed_replacement: tool({
    name: "apply_reviewed_replacement",
    description: "Request approval to replace exactly one literal oldText with newText in an existing file. Bind expectedDigest to the inspected full file. Include enough surrounding text to make oldText unique; no regex. Prefer this for small repairs instead of returning the whole file.",
    schema: replacementEditSchema,
    ...mutationApproval,
    execute: async (input, context) => serializeJsonValue(editContractDocument(
      "patch-result", await (harnessExecutionSession(context)?.workspace ?? workspace).applyReplacement(input)
    ))
  }),
  apply_reviewed_edits: tool({
    name: "apply_reviewed_edits",
    description: "Request approval for complete digest-bound changes and atomically apply them without copying a separate proposalId between model turns. The exact paths, expected digests, and contents are the approval payload.",
    schema: editProposalInputSchema,
    ...mutationApproval,
    execute: async ({ changes }, context) => {
      const proposal = createEditProposal({ changes });
      return serializeJsonValue(editContractDocument(
        "patch-result",
        await (harnessExecutionSession(context)?.workspace ?? workspace).applyPatch({
          proposalId: proposal.proposalId,
          changes
        })
      ));
    }
  }),
  move_file: tool({
    name: "move_file",
    description: "Move one regular file without overwriting the destination. The source must still match expectedDigest.",
    schema: moveFileInputSchema,
    ...mutationApproval,
    execute: async (input, context) => serializeJsonValue(editContractDocument(
      "move-result",
      await (harnessExecutionSession(context)?.workspace ?? workspace).moveFile(input)
    ))
  }),
  quarantine_file: tool({
    name: "quarantine_file",
    description: "Recoverably remove one regular file into harness-owned quarantine after verifying expectedDigest. Permanent deletion is unavailable.",
    schema: quarantineFileInputSchema,
    ...mutationApproval,
    execute: async (input, context) => serializeJsonValue(editContractDocument(
      "quarantine-result",
      await (harnessExecutionSession(context)?.workspace ?? workspace).quarantineFile(input)
    ))
  }),
  restore_file: tool({
    name: "restore_file",
    description: "Restore a quarantined file to its original path or an explicit safe destination without overwriting content unexpectedly.",
    schema: restoreFileInputSchema,
    ...mutationApproval,
    execute: async (input, context) => serializeJsonValue(editContractDocument(
      "restore-result",
      await (harnessExecutionSession(context)?.workspace ?? workspace).restoreQuarantined(input)
    ))
  }),
  run_check: tool({
    name: "run_check",
    description: `Run one explicitly allowed package.json script through the repository package manager (${allowedChecks.join(", ")}). Read package.json first and pass its exact script text as expectedScript so the operator can review the command. No arbitrary shell or implicit lifecycle hook is exposed.`,
    schema: z.object({
      check: z.string().min(1).max(100).regex(/^[A-Za-z0-9:_-]+$/),
      expectedScript: z.string().min(1).max(2000)
    }),
    requiresApproval: true,
    approvalMode: "interrupt",
    approvalVersion: APPROVAL_VERSION,
    metadata: toolMetadata(["code-execution"], "high"),
    execute: async ({ check, expectedScript }, context) => {
      const execution = harnessExecutionSession(context);
      return serializeJsonValue(await (execution
        ? execution.runCheck(check, expectedScript, allowedChecks, context)
        : workspace.runCheck(check, expectedScript, allowedChecks)));
    }
  }),
  mutation_audit: tool({
    name: "mutation_audit",
    description: "Inspect governed filesystem edit receipts. OCI receipts persist across reacquisition of this run. Command effects are recorded separately in the command journal; inspect_environment_patch shows the aggregate candidate, including command effects.",
    schema: z.object({}),
    metadata: readOnlyMetadata,
    execute: async (_input, context) => serializeJsonValue(editContractDocument(
      "mutation-audit",
      (harnessExecutionSession(context)?.workspace ?? workspace).mutationAudit()
    ))
  }),
  git_diff: tool({
    name: "git_diff",
    description: "Inspect final Git status, unstaged diff, staged diff, and this harness instance's mutation audit. This tool is read-only and does not commit, stage, reset, or push.",
    schema: z.object({}),
    metadata: readOnlyMetadata,
    execute: async () => serializeJsonValue(editContractDocument("workspace-diff", {
      ...(await workspace.gitDiff()),
      mutations: workspace.mutationAudit()
    }))
  })
});
