import { tool, type ToolExecutionContext } from "@zhivex-ai/agents";
import { serializeJsonValue } from "@zhivex-ai/core";
import { z } from "zod";
import { type HarnessConfig } from "../runtime/config.js";
import { createEditProposal, fileDigestSchema } from "../workspace/edit-contracts.js";
import { Workspace } from "../workspace/workspace.js";
import { harnessExecutionSession } from "../execution/execution-environment.js";
import {
  APPROVAL_VERSION,
  TerminalVerificationFailure,
  assertActiveTool,
  mutationApproval,
  readOnlyMetadata,
  toolMetadata,
  verifiedReviewedEditsInputSchema,
  verifierFailureDetails
} from "./shared.js";

const requireExecutionSession = (context: ToolExecutionContext | undefined) => {
  const session = harnessExecutionSession(context);
  if (!session) throw new Error("This tool requires an active enforced OCI execution session.");
  return session;
};

export const createExecutionEnvironmentTools = (
  workspace: Workspace,
  execution?: Extract<HarnessConfig["execution"], { backend: "oci" }>
) => {
  const commandSchema = execution
    ? z.enum(execution.allowedCommands)
    : z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
  const commandGuidance = execution
    ? ` Allowed executables: ${execution.allowedCommands.join(", ")}. Pass arguments separately; an allowed executable is not a guarantee that it is installed.${execution.allowedCommands.includes("python") || execution.allowedCommands.includes("python3") ? ` For pytest, use ${execution.allowedCommands.includes("python") ? "python" : "python3"} with args ["-m", "pytest", ...] when pytest is installed.` : ""}`
    : " Inspect environment_status for the active executable allowlist before choosing a command.";
  return {
    run_environment_command: tool({
      name: "run_environment_command",
      description: "Run one allowlisted argv command inside the enforced OCI snapshot. This never invokes a host shell, inherits no host environment variables, and has no network by default." + commandGuidance,
      schema: z.strictObject({
        command: commandSchema,
        args: z.array(z.string().max(8_192)).max(256).default([])
      }),
      requiresApproval: true,
      approvalMode: "interrupt",
      approvalVersion: APPROVAL_VERSION,
      metadata: toolMetadata(["code-execution", "filesystem"], "high"),
      execute: async ({ command, args }, context) => serializeJsonValue(
        await requireExecutionSession(context).runCommand(command, args, context)
      )
    }),
    run_environment_batch: tool({
      name: "run_environment_batch",
      description: "Run 1 to 32 reviewed allowlisted argv commands sequentially inside one enforced OCI cycle. Execution stops on the first failure and the workspace is attested and published only after the batch succeeds; no host shell or network is exposed." + commandGuidance,
      schema: z.strictObject({
        commands: z.array(z.strictObject({
          command: commandSchema,
          args: z.array(z.string().max(8_192)).max(256).default([])
        })).min(1).max(32)
      }).superRefine((input, context) => {
        if (input.commands.reduce((total, command) => total + command.args.length, 0) > 256) {
          context.addIssue({
            code: "custom",
            path: ["commands"],
            message: "run_environment_batch allows at most 256 aggregate arguments."
          });
        }
      }),
      requiresApproval: true,
      approvalMode: "interrupt",
      approvalVersion: APPROVAL_VERSION,
      metadata: toolMetadata(["code-execution", "filesystem"], "high"),
      execute: async ({ commands }, context) => serializeJsonValue(
        await requireExecutionSession(context).runCommandBatch(commands, context)
      )
    }),
    ...(execution?.shellMode === "ask" ? {
      run_environment_shell: tool({
        name: "run_environment_shell",
        description: "Run a complete shell script through sh inside the enforced OCI snapshot. The exact script requires durable approval; the host never interprets it, container network remains denied, and host changes still require separate patch import approval.",
        schema: z.strictObject({
          script: z.string().min(1).max(16_384).refine((value) => !value.includes("\0"), "Shell scripts cannot contain NUL bytes.")
        }),
        requiresApproval: true,
        approvalMode: "interrupt" as const,
        approvalVersion: "2026-08-21-oci-shell-v1",
        metadata: toolMetadata(["code-execution", "filesystem"], "high"),
        execute: async ({ script }, context) => serializeJsonValue(
          await requireExecutionSession(context).runShell(script, context)
        )
      })
    } : {}),
    environment_status: tool({
      name: "environment_status",
      description: "Inspect the immutable image binding and enforced policy for the active run without exposing host paths or environment variables.",
      schema: z.object({}),
      metadata: readOnlyMetadata,
      execute: async (_input, context) => serializeJsonValue(await requireExecutionSession(context).status())
    }),
    inspect_environment_patch: tool({
      name: "inspect_environment_patch",
      description: "Inspect a content-bound summary of changes made in the ephemeral OCI snapshot. Content remains in harness-owned state until a separately approved import.",
      schema: z.object({}),
      metadata: readOnlyMetadata,
      execute: async (_input, context) => serializeJsonValue(await requireExecutionSession(context).inspectPatch())
    }),
    apply_environment_patch: tool({
      name: "apply_environment_patch",
      description: "Import an unchanged reviewed OCI snapshot patch into the host workspace. Host digests are rechecked and deletions use recoverable quarantine.",
      schema: z.strictObject({ patchId: fileDigestSchema }),
      ...mutationApproval,
      execute: async ({ patchId }, context) => serializeJsonValue(
        await requireExecutionSession(context).importPatch(workspace, patchId, () => assertActiveTool(context))
      )
    }),
    verify_and_apply_environment_patch: tool({
      name: "verify_and_apply_environment_patch",
      description: "Request one approval to verify an already inspected content-bound OCI patch with exact allowlisted argv and import it only when verification succeeds without changing the reviewed patch." + commandGuidance,
      schema: z.strictObject({
        patchId: fileDigestSchema,
        command: commandSchema,
        args: z.array(z.string().max(8_192)).max(256).default([])
      }),
      requiresApproval: true,
      approvalMode: "interrupt",
      approvalVersion: "2026-08-21-verify-and-apply-v1",
      metadata: toolMetadata(["code-execution", "filesystem"], "high"),
      execute: async ({ patchId, command, args }, context) => {
        const session = requireExecutionSession(context);
        const beforeVerification = await session.inspectPatch();
        if (beforeVerification.patchId !== patchId) {
          throw new Error("The OCI patch changed after review; inspect it again before verification and import.");
        }
        const verification = await session.runCommand(command, args, context);
        if (verification.exitCode !== 0) {
          throw new TerminalVerificationFailure(
            verifierFailureDetails(verification),
            // OCI maps timeout/output-limit/cancellation to 124/125/130.
            // Conservatively exclude all reserved/signal exits from recovery.
            Number.isSafeInteger(verification.exitCode) && verification.exitCode > 0 &&
              verification.exitCode < 124 && !verification.timedOut
          );
        }
        const afterVerification = await session.inspectPatch();
        if (afterVerification.patchId !== patchId) {
          throw new Error("The verifier changed the reviewed OCI patch; the host workspace was not changed.");
        }
        await assertActiveTool(context);
        const imported = await session.importPatch(workspace, patchId, () => assertActiveTool(context));
        return serializeJsonValue({
          schemaVersion: 1,
          kind: "verified-environment-patch-import",
          patchId,
          verification,
          imported
        });
      }
    }),
    verify_and_apply_reviewed_edits: tool({
      name: "verify_and_apply_reviewed_edits",
      description: "Request one approval for complete digest-bound edits and exact verifier argv. The transaction requires a clean OCI snapshot, applies the edits atomically, rejects verifier-created drift, and imports the reviewed patch only after exit code 0." + commandGuidance,
      schema: verifiedReviewedEditsInputSchema.extend({ command: commandSchema }),
      requiresApproval: true,
      approvalMode: "interrupt",
      approvalVersion: "2026-08-21-verify-reviewed-edits-v1",
      metadata: toolMetadata(["code-execution", "filesystem", "write"], "high"),
      execute: async ({ changes, command, args }, context) => {
        const session = requireExecutionSession(context);
        const initialPatch = await session.inspectPatch();
        if (initialPatch.entries.length !== 0) {
          throw new Error("The verified edit transaction requires a clean OCI snapshot; the host workspace was not changed.");
        }

        const proposal = createEditProposal({ changes });
        await session.workspace.applyPatch({ proposalId: proposal.proposalId, changes });
        const reviewedPatch = await session.inspectPatch();
        const approvedPaths = [...new Set(changes.map((change) => change.path))].sort();
        const reviewedPaths = reviewedPatch.entries.map((entry) => entry.path).sort();
        if (JSON.stringify(reviewedPaths) !== JSON.stringify(approvedPaths)) {
          throw new Error("The OCI patch does not match the approved edit paths; the host workspace was not changed.");
        }

        const verification = await session.runCommand(command, args, context);
        if (verification.exitCode !== 0) {
          throw new TerminalVerificationFailure(
            verifierFailureDetails(verification),
            Number.isSafeInteger(verification.exitCode) && verification.exitCode > 0 &&
              verification.exitCode < 124 && !verification.timedOut
          );
        }
        const afterVerification = await session.inspectPatch();
        if (afterVerification.patchId !== reviewedPatch.patchId) {
          throw new Error("The verifier changed the reviewed OCI patch; the host workspace was not changed.");
        }
        await assertActiveTool(context);
        const imported = await session.importPatch(workspace, reviewedPatch.patchId, () => assertActiveTool(context));
        return serializeJsonValue({
          schemaVersion: 1,
          kind: "verified-reviewed-edit-import",
          proposalId: proposal.proposalId,
          patchId: reviewedPatch.patchId,
          verification,
          imported
        });
      }
    })
  };
};
