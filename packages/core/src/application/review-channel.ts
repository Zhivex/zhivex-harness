import { createRedactionPolicy } from "@zhivex-ai/agents";
import { z } from "zod";
import { harnessClientRequestSchema, type HarnessClientAdapter, type HarnessClientResponse, type HarnessClientRun } from "../client/protocol.js";
import { projectApprovalReview, type ApprovalReview } from "./approval-review.js";
import { ReviewTickets, type TicketedApprovalReview } from "./review-tickets.js";

export type ApplicationReviewResponse = { ok: true; review: TicketedApprovalReview } | { ok: false; error: { code: string } };
const decisionSchema = z.object({
  protocolVersion: z.literal(1), requestId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128), projectId: z.string().min(1).max(128),
  clientId: z.string().uuid(), ticketId: z.string().uuid(), approve: z.boolean(),
}).strict();

/** Enabled only by the application host on its authenticated, owner-private socket.
 * Raw engine commands never acquire reviewed authority. A client must first get
 * the bounded host projection and resolve its connection-bound, single-use receipt.
 */
export function createApplicationReviewChannel(adapter: HarnessClientAdapter, secrets: readonly string[], options: { tools?: readonly string[]; project?: (run: HarnessClientRun, redact: (text: string) => string, redactContactDetails: (text: string) => string) => Promise<ApprovalReview> } = {}) {
  const receipts = new Map<string, { connectionId: string; clientId: string; tickets: ReviewTickets }>();
  const policy = createRedactionPolicy({ includeEmails: true });
  const contactPolicy = createRedactionPolicy({ includeEmails: false });
  const protect = (text: string, selectedPolicy: typeof policy) => {
    for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
    return selectedPolicy.redactText(text).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi, "[REDACTED]");
  };
  const redact = (text: string) => protect(text, policy);
  // Only the trusted projection decides which contact-bearing review needs recipient visibility.
  const redactContactDetails = (text: string) => protect(text, contactPolicy);
  return {
    async review(value: unknown): Promise<ApplicationReviewResponse> {
      const outer = z.object({ clientId: z.string().uuid(), request: harnessClientRequestSchema }).strict().safeParse(value);
      const parsed = outer.success ? { success: true as const, data: outer.data.request } : outer;
      if (!parsed.success || parsed.data.command.method !== "run.get" || !parsed.data.command.includeReview) {
        return { ok: false, error: { code: "INVALID_REQUEST" } };
      }
      const response = await adapter.dispatch(parsed.data);
      if (!response.ok) return response;
      if (response.data.kind !== "run") return { ok: false, error: { code: "REVIEW_UNAVAILABLE" } };
      const tickets = new ReviewTickets(options.tools);
      const review = tickets.issue(parsed.data.command.sessionId, options.project ? await options.project(response.data.run, redact, redactContactDetails) : projectApprovalReview(response.data.run, redact));
      receipts.set(review.ticketId, { connectionId: parsed.data.connectionId, clientId: outer.success ? outer.data.clientId : "", tickets });
      while (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
      return { ok: true, review };
    },
    async decide(value: unknown): Promise<HarnessClientResponse> {
      const parsed = decisionSchema.parse(value);
      const entry = receipts.get(parsed.ticketId);
      if (!entry || entry.connectionId !== parsed.connectionId || entry.clientId !== parsed.clientId) throw new Error("REVIEW_REQUIRED");
      receipts.delete(parsed.ticketId);
      const command = entry.tickets.consume(parsed.ticketId, parsed.approve);
      if (!adapter.dispatchReviewed) throw new Error("EXPLICIT_REVIEW_UNAVAILABLE");
      return adapter.dispatchReviewed({ protocolVersion: 1, requestId: parsed.requestId, connectionId: parsed.connectionId,
        command: { ...command, projectId: parsed.projectId } });
    },
  };
}
