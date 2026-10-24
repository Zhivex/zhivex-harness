import type { AgentApprovalRequest } from "@zhivex-ai/agents";
import { createEditProposal, editChangesSchema, type Workspace } from "@zhivex-ai/harness/engine";
import { revealInvisible } from "../../../../../src/review/reveal-invisible.js";
import { sanitizeTerminalText } from "./terminal-ui.js";

export interface FileDiff { path: string; before: string | null; after: string | null }

/** A linear changed-region diff. `context` lines of unchanged text stay visible; the rest collapses. */
export const formatFileDiff = ({ path, before, after }: FileDiff, context = 3): string => {
  const lines = (text: string | null) => text === null || text === "" ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const old = lines(before), next = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const name = sanitizeTerminalText(JSON.stringify(path));
  if (before === after) return `File ${name}: unchanged\n`;
  const finite = Number.isFinite(context) ? Math.max(0, context) : Number.MAX_SAFE_INTEGER;
  const lead = Math.min(finite, prefix);
  const trail = Math.min(finite, suffix);
  const start = prefix - lead;
  const oldEnd = old.length - suffix + trail;
  const newEnd = next.length - suffix + trail;
  const render = (mark: string, line: string) => mark + revealInvisible(line.endsWith("\n") ? line.slice(0, -1) : line) + "\n" +
    (line.endsWith("\n") ? "" : "\\ No newline at end of file\n");
  const banner = (count: number) => count > 0 ? `··· ${count} unchanged line${count === 1 ? "" : "s"}\n` : "";
  const oldCount = old.length ? oldEnd - start : 0;
  const newCount = next.length ? newEnd - start : 0;
  return `--- ${before === null ? "/dev/null" : name}\n+++ ${after === null ? "/dev/null" : name}\n` +
    banner(start) +
    `@@ -${old.length ? start + 1 : 0},${oldCount} +${next.length ? start + 1 : 0},${newCount} @@\n` +
    old.slice(start, prefix).map(line => render(" ", line)).join("") +
    old.slice(prefix, old.length - suffix).map(line => render("-", line)).join("") +
    next.slice(prefix, next.length - suffix).map(line => render("+", line)).join("") +
    next.slice(next.length - suffix, newEnd).map(line => render(" ", line)).join("") +
    banner(Math.max(0, suffix - trail));
};

/** Preview only known local tools through engine validation. Never authorizes an edit. */
export const approvalFileDiff = async (workspace: Workspace, approval: AgentApprovalRequest, context = 3): Promise<string | undefined> => {
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
    const diff = preview.files.map(file => formatFileDiff(file, context)).join("\n");
    if (Buffer.byteLength(diff) > 128 * 1024) return "File diff unavailable: exceeds terminal preview limit. Review the complete payload below.\n";
    return `Reviewed file diff · ${preview.proposalId}\n${diff}`;
  } catch {
    return "File diff unavailable: preconditions or text preview could not be validated. Review the complete payload below; engine checks still apply.\n";
  }
};
