import {
  loadApprovalConfig,
  resolveAutoApprovePolicy,
  writeApprovalConfig,
  type ApprovalConfigFile,
  type AutoApproveMode,
} from "../../../../src/approvals/auto-approve.js";
import type { CliOptions } from "./arguments.js";

/** Session override wins over the CLI flag, which wins over `.zhivex-harness/approval.json`. */
export const createAutoApproveController = (workspace: string, options: CliOptions, file: ApprovalConfigFile) => {
  let stored = file;
  let sessionMode: AutoApproveMode | undefined;
  let sessionAllow: readonly string[] | undefined;
  return {
    policy(overLimit = false) {
      return resolveAutoApprovePolicy({
        rootDir: workspace,
        file: stored,
        ...(options.autoApproveMode ? { cliMode: options.autoApproveMode } : {}),
        ...(options.autoApproveAllow?.length ? { cliAllow: options.autoApproveAllow } : {}),
        ...(sessionMode ? { sessionMode } : {}),
        ...(sessionAllow ? { sessionAllow } : {}),
        ...(overLimit ? { overLimit: true } : {}),
      });
    },
    setSession(mode: AutoApproveMode) { sessionMode = mode; },
    async saveWorkspace(mode: AutoApproveMode) {
      stored = { mode, commandAllowlist: stored.commandAllowlist };
      sessionMode = mode;
      await writeApprovalConfig(workspace, stored);
    },
  };
};

export const openAutoApproveController = async (workspace: string, options: CliOptions) => {
  let file: ApprovalConfigFile = { mode: "manual", commandAllowlist: [] };
  try { file = await loadApprovalConfig(workspace); }
  catch (error) {
    process.stderr.write(`Approval config was not loaded (${error instanceof Error ? error.message : "invalid"}). Approvals stay manual.\n`);
  }
  return createAutoApproveController(workspace, options, file);
};
