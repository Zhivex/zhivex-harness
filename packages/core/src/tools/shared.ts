import { createRedactionPolicy, type ToolExecutionContext } from "@zhivex-ai/agents";
import { z } from "zod";
import { editProposalInputSchema, type EditChange } from "../workspace/edit-contracts.js";
import { Workspace } from "../workspace/workspace.js";
import { HarnessExecutionError } from "../runtime/errors.js";

export const APPROVAL_VERSION = "2026-08-17-v5";

const verifierDiagnosticRedaction = createRedactionPolicy({ includeEmails: true });

export const verifierFailureDetails = (result: { exitCode: number; timedOut: boolean; stdout: string; stderr: string }) => {
  const redact = (text: string) => verifierDiagnosticRedaction.redactText(text)
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|password)\s*([=:])\s*(?:"[^\"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]");
  const stdout = redact(result.stdout), stderr = redact(result.stderr);
  const bounded = (text: string) => text.length <= 2048 ? text : `${text.slice(0, 1000)}\n[truncated]\n${text.slice(-1000)}`;
  return { exitCode: result.exitCode, timedOut: result.timedOut, diagnostics: {
    source: "untrusted-verifier-output" as const,
    stdout: bounded(stdout), stderr: bounded(stderr),
    truncated: stdout.length > 2048 || stderr.length > 2048
  } };
};

export class TerminalVerificationFailure extends HarnessExecutionError {
  constructor(readonly verification: ReturnType<typeof verifierFailureDetails>, readonly recoverable: boolean) {
    super(`The approved verifier failed with exit code ${verification.exitCode}; the host workspace was not changed.`);
  }
}

export const verifyEditPreconditions = async (workspace: Workspace, changes: readonly EditChange[]) => {
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

export const toolMetadata = (
  permissions: readonly ("read" | "write" | "filesystem" | "code-execution")[],
  riskLevel: "low" | "high"
) => ({
  advancedRegistry: {
    permissions: [...permissions],
    audit: { riskLevel }
  }
});

export const readOnlyMetadata = toolMetadata(["read"], "low");

export const mutationApproval = {
  requiresApproval: true,
  approvalMode: "interrupt" as const,
  approvalVersion: APPROVAL_VERSION,
  metadata: toolMetadata(["filesystem", "write"], "high")
};

const verifierCommandSchema = z.strictObject({
  command: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  args: z.array(z.string().max(8_192)).max(256).default([])
});

export const verifiedReviewedEditsInputSchema = editProposalInputSchema.extend({
  command: verifierCommandSchema.shape.command,
  args: verifierCommandSchema.shape.args
});

export const terminalCheckpoint = Symbol("terminalCheckpoint");

export const assertActiveTool = async (context?: ToolExecutionContext) => {
  context?.abortSignal?.throwIfAborted();
  await (context as (ToolExecutionContext & { [terminalCheckpoint]?: () => Promise<void> }) | undefined)?.[terminalCheckpoint]?.();
  context?.abortSignal?.throwIfAborted();
};
