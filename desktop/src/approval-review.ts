import { createHash } from "node:crypto";
import type { HarnessClientRun } from "../../src/client-contract.js";
export interface ApprovalReviewFile { path: string; expectedDigest: string | null; before?: string; after?: string; view: "literal-replacement" | "replacement-contents" | "operation" | "full-file"; afterDigest?: string | null; beforeMode?: number; afterMode?: number; operation?: "create" | "update" | "delete" }
export interface ApprovalReviewItem {
    approvalId: string; digest: string; expiresAt: number; name: string; payloadDigest: string;
    payload: string; files: ApprovalReviewFile[]; commands: string[]; consequence: string;
    complete: boolean; restriction?: "REDACTED" | "TOO_LARGE" | "INVALID_PAYLOAD" | "BASE_UNAVAILABLE";
}
export interface ApprovalReview { schemaVersion: 1; runId: string; revision: number; status: string; items: ApprovalReviewItem[] }
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** Host-only projection. The approval digest stays opaque and the runtime remains authoritative. */
export function projectApprovalReview(run: HarnessClientRun, redact: (text: string) => string): ApprovalReview {
    return {
        schemaVersion: 1, runId: run.runId, revision: run.revision, status: run.status, items: run.approvals.map(approval => {
            const action = object(approval.action), name = typeof action?.name === "string" ? action.name : "unknown";
            const raw = typeof action?.arguments === "string" ? action.arguments : "";
            const base = { approvalId: approval.approvalId, digest: approval.digest, expiresAt: approval.expiresAt, name: redact(name), payloadDigest: digest(raw) };
            if (Buffer.byteLength(raw) > 256 * 1024) return { ...base, payload: "Content exceeds the review limit.", files: [], commands: [], consequence: "The operation requires a complete review before approval.", complete: false, restriction: "TOO_LARGE" as const };
            let args: Record<string, unknown> | undefined; try { args = object(JSON.parse(raw)); } catch { }
            if (!args) return { ...base, payload: "Could not parse the approval content.", files: [], commands: [], consequence: "Do not approve content that cannot be reviewed.", complete: false, restriction: "INVALID_PAYLOAD" as const };
            const payload = JSON.stringify(args, null, 2), safe = redact(payload), files: ApprovalReviewFile[] = [], commands: string[] = [];
            if (name === "apply_reviewed_replacement" && typeof args.path === "string" && typeof args.expectedDigest === "string" && typeof args.oldText === "string" && typeof args.newText === "string") files.push({ path: args.path, expectedDigest: args.expectedDigest, before: args.oldText, after: args.newText, view: "literal-replacement" });
            if (Array.isArray(args.changes)) for (const change of args.changes) { const c = object(change); if (c && typeof c.path === "string" && (c.expectedDigest === null || typeof c.expectedDigest === "string") && typeof c.content === "string") files.push({ path: c.path, expectedDigest: c.expectedDigest, after: c.content, view: "replacement-contents" }); }
            if (name === "run_check" && typeof args.expectedScript === "string") commands.push(args.expectedScript);
            if (typeof args.command === "string") commands.push(JSON.stringify([args.command, ...(Array.isArray(args.args) ? args.args : [])]));
            if (typeof args.script === "string") commands.push(args.script);
            if (Array.isArray(args.commands)) for (const entry of args.commands) { const c = object(entry); if (c && typeof c.command === "string") commands.push(JSON.stringify([c.command, ...(Array.isArray(c.args) ? c.args : [])])); }
            const needsBase = ["apply_patch", "apply_reviewed_edits", "apply_reviewed_replacement", "apply_environment_patch", "verify_and_apply_environment_patch", "verify_and_apply_reviewed_edits"].includes(name);
            const preview = approval.filePreview;
            if (needsBase && preview?.status === "complete") {
                files.length = 0;
                files.push(...preview.files.map(file => ({ path: file.path, expectedDigest: file.expectedDigest, before: file.before ?? "", after: file.after ?? "", afterDigest: file.afterDigest, ...(file.beforeMode === undefined ? {} : { beforeMode: file.beforeMode }), ...(file.afterMode === undefined ? {} : { afterMode: file.afterMode }), ...(file.operation ? { operation: file.operation } : {}), view: "full-file" as const })));
            }
            const execution = name === "run_check" || name.startsWith("run_environment_") || name.startsWith("verify_and_apply_");
            const mutation = name.startsWith("apply_") || name.startsWith("verify_and_apply_") || ["move_file", "quarantine_file", "restore_file"].includes(name);
            const consequence = [execution ? "Authorizes running the displayed commands; does not certify that checks pass." : "", mutation ? "Authorizes the specified change with its content preconditions." : "", !execution && !mutation ? "Authorizes the exact operation shown; the engine validates capabilities and scope." : ""].filter(Boolean).join(" ");
            const changed = safe !== payload || redact(name) !== name || redact(JSON.stringify(files)) !== JSON.stringify(files);
            const baseUnavailable = needsBase && preview?.status !== "complete";
            return { ...base, payload: safe, files: files.map(file => ({ ...file, path: redact(file.path), expectedDigest: file.expectedDigest === null ? null : redact(file.expectedDigest), ...(file.before === undefined ? {} : { before: redact(file.before) }), ...(file.after === undefined ? {} : { after: redact(file.after) }) })), commands: commands.map(redact), consequence, complete: !changed && !baseUnavailable, ...(changed ? { restriction: "REDACTED" as const } : baseUnavailable ? { restriction: "BASE_UNAVAILABLE" as const } : {}) };
        })
    };
}
