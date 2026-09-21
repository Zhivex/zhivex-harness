import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import type { AgentRunState } from "@zhivex-ai/core";
import { APPROVAL_DIFFS_KEY, captureApprovalDiffs, attachAppliedDiffs } from "../src/approval-diff.js";
import type { ApprovalDecisionView } from "../src/approval-history.js";
import type { HarnessClientRun } from "../src/client-contract.js";
const digest = (value: string | null) => value === null ? null : "sha256:" + createHash("sha256").update(value).digest("hex");
const file = (before: string | null = "\ufeffantes\r\n", after: string | null = "después\r\n") => ({ path: "a.txt", before, after, expectedDigest: digest(before), afterDigest: digest(after) });
const proposalId = "sha256:" + "a".repeat(64), approvalId = "approval", hash = "b".repeat(64);
const state = (entries: unknown = []) => ({ metadata: { [APPROVAL_DIFFS_KEY]: entries } } as unknown as AgentRunState);
const preview = (files = [file()]): HarnessClientRun => ({ runId: "run", revision: 2, status: "waiting_approval", output: "", approvals: [{ approvalId, digest: hash, provider: "openai", kind: "local", action: {}, expiresAt: 100, filePreview: { status: "complete", proposalId, files } }] });
const row = (files = [file()]): ApprovalDecisionView => ({ approvalId, digest: hash, name: "apply_patch", approved: true, decidedAt: 1, reviewedRevision: 2, status: "applied", evidence: { journalRevision: 1, proposalId, effects: files.map(file => ({ path: file.path, beforeDigest: file.expectedDigest, afterDigest: file.afterDigest })) } });
test("saved content requires exact applied receipt, including Unicode, BOM and CRLF bytes", () => {
    for (const files of [[file()], [file(null, "new")], [file("old", null)]]) {
        const captured = captureApprovalDiffs(state(), preview(files), new Set([approvalId]));
        expect(attachAppliedDiffs(state(captured), [row(files)])[0]!.finalDiff).toEqual({ status: "complete", files });
    }
});
test("missing, corrupt, partial or mismatched archives do not masquerade as final diffs", () => {
    const captured = captureApprovalDiffs(state(), preview(), new Set([approvalId]));
    const valid = captured[0]!;
    for (const entries of [[], [{ ...valid, proposalId: "sha256:" + "c".repeat(64) }], [{ ...valid, digest: "d".repeat(64) }], [{ ...valid, files: [{ ...file(), before: "tampered" }] }], [{ ...valid, files: [{ ...file(), after: "tampered" }] }], [{ ...valid, files: [{ ...file(), path: "other" }] }], [{ ...valid, files: [file(), file()] }], { not: "an archive" }]) {
        expect(attachAppliedDiffs(state(entries), [row()])[0]!.finalDiff).toEqual({ status: "unavailable" });
    }
    for (const status of ["approved", "unknown", "failed", "rejected"] as const) expect(attachAppliedDiffs(state(captured), [{ ...row(), status }])[0]!.finalDiff).toBeUndefined();
    expect(captureApprovalDiffs(state(), preview(), new Set())).toEqual([]);
});
test("verified reviewed edits bind their reviewed proposal separately from the OCI patch", () => {
    const captured = captureApprovalDiffs(state(), preview(), new Set([approvalId]));
    const decision = row(); decision.evidence!.reviewedProposalId = proposalId; decision.evidence!.proposalId = "sha256:" + "c".repeat(64);
    expect(attachAppliedDiffs(state(captured), [decision])[0]!.finalDiff?.status).toBe("complete");
});
test("the archive is bounded across a run and old evidence is retained", () => {
    let captured = captureApprovalDiffs(state(), preview(), new Set([approvalId]));
    for (let i = 0; i < 12; i++)captured = captureApprovalDiffs(state(captured), preview([file("a".repeat(128 * 1024), "b".repeat(128 * 1024))]), new Set([approvalId]));
    expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(captured.length).toBeLessThan(13); expect(captured[0]!.files[0]!.before).toBe("\ufeffantes\r\n");
});
