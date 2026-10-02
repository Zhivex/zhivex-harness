import type { AgentApprovalRequest } from "@zhivex-ai/agents";
import { createEditProposal, editChangesSchema, type Workspace } from "@zhivex-ai/harness/engine";
import { sanitizeTerminalText } from "./terminal-ui.js";

export interface FileDiff { path: string; before: string | null; after: string | null }

/** A linear, complete changed-region diff. No quadratic matching on repository text. */
export const formatFileDiff = ({ path, before, after }: FileDiff): string => {
  const lines = (text: string | null) => text === null || text === "" ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const old = lines(before), next = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const name = sanitizeTerminalText(JSON.stringify(path));
  if (before === after) return `File ${name}: unchanged\n`;
  const start = Math.max(0, prefix - 3);
  const oldEnd = Math.min(old.length, old.length - suffix + 3);
  const newEnd = Math.min(next.length, next.length - suffix + 3);
  const render = (mark: string, line: string) => mark + sanitizeTerminalText(line.endsWith("\n") ? line.slice(0, -1) : line) + "\n" +
    (line.endsWith("\n") ? "" : "\\ No newline at end of file\n");
  return `--- ${before === null ? "/dev/null" : name}\n+++ ${after === null ? "/dev/null" : name}\n` +
    `@@ -${old.length ? start + 1 : 0},${oldEnd - start} +${next.length ? start + 1 : 0},${newEnd - start} @@\n` +
    old.slice(start, prefix).map(line => render(" ", line)).join("") +
    old.slice(prefix, old.length - suffix).map(line => render("-", line)).join("") +
    next.slice(prefix, next.length - suffix).map(line => render("+", line)).join("") +
    next.slice(next.length - suffix, newEnd).map(line => render(" ", line)).join("");
};

/** Preview only known local tools through engine validation. Never authorizes an edit. */
export const approvalFileDiff = async (workspace: Workspace, approval: AgentApprovalRequest): Promise<string | undefined> => {
  if (approval.kind !== "local-tool") return;
  if (!["apply_patch", "apply_reviewed_edits", "verify_and_apply_reviewed_edits", "apply_reviewed_replacement"].includes(approval.name)) return;
  try {
    const args = JSON.parse(approval.arguments);
    let preview;
    if (approval.name === "apply_reviewed_replacement") preview = await workspace.previewReplacement(args);
    else {
      const changes = editChangesSchema.parse(args.changes);
      const proposalId = approval.name === "apply_patch" ? args.proposalId : createEditProposal({ changes }).proposalId;
      preview = await workspace.previewPatch({ proposalId, changes });
    }
    const diff = preview.files.map(formatFileDiff).join("\n");
    if (Buffer.byteLength(diff) > 128 * 1024) return "File diff unavailable: exceeds terminal preview limit. Review the complete payload below.\n";
    return `Reviewed file diff · ${preview.proposalId}\n${diff}`;
  } catch {
    return "File diff unavailable: preconditions or text preview could not be validated. Review the complete payload below; engine checks still apply.\n";
  }
};
