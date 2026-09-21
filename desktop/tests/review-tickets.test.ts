import { test, expect } from "bun:test";
import { ReviewTickets } from "../src/review-tickets.js";
import type { ApprovalReview } from "../src/approval-review.js";
const review = (): ApprovalReview => ({ schemaVersion: 1, runId: "run_a", revision: 8, status: "waiting_approval", items: [{ approvalId: "a", digest: "a".repeat(64), expiresAt: 2000, name: "run_check", payloadDigest: "sha256:fixture", payload: '{"check":"test"}', files: [], commands: ["bun test"], consequence: "Execute", complete: true }] });
test("receipt captures immutable scope and is consumed once before dispatch", () => {
    const tickets = new ReviewTickets(), source = review(), issued = tickets.issue("session_a", source);
    source.revision = 99; issued.items[0]!.digest = "b".repeat(64);
    const decision = tickets.consume(issued.ticketId, true, 1000);
    expect(decision).toMatchObject({ sessionId: "session_a", runId: "run_a", expectedRevision: 8, decisions: [{ approvalId: "a", digest: "a".repeat(64), approve: true }] });
    expect(() => tickets.consume(issued.ticketId, true, 1000)).toThrow("REVIEW_REQUIRED");
});
test("expired, fabricated, incomplete and unsupported approvals fail closed", () => {
    const tickets = new ReviewTickets();
    expect(() => tickets.consume("forged", true, 1000)).toThrow("REVIEW_REQUIRED");
    const expired = tickets.issue("s", review()); expect(() => tickets.consume(expired.ticketId, false, 2000)).toThrow("REVIEW_EXPIRED");
    for (const variant of [{ ...review().items[0]!, complete: false }, { ...review().items[0]!, name: "unsupported_tool" }]) {
        const view = { ...review(), items: [variant] }, issued = tickets.issue("s", view);
        expect(issued.canApprove).toBe(false);
        expect(() => tickets.consume(issued.ticketId, true, 1000)).toThrow("REVIEW_INCOMPLETE");
        expect(tickets.consume(issued.ticketId, false, 1000).decisions[0]!.approve).toBe(false);
    }
});
test("receipt storage is bounded and strict decision types prevent coercion", () => {
    const tickets = new ReviewTickets(), first = tickets.issue("s", review());
    for (let i = 0; i < 128; i++)tickets.issue("s", review());
    expect(() => tickets.consume(first.ticketId, true, 1000)).toThrow("REVIEW_REQUIRED");
    const last = tickets.issue("s", review()); expect(() => tickets.consume(last.ticketId, "true", 1000)).toThrow("INVALID_DECISION");
    expect(tickets.consume(last.ticketId, true, 1000).decisions).toHaveLength(1);
});
