import type {
  HarnessClientRun,
  HarnessClientSession,
  HarnessActivityPage,
} from "@zhivex-ai/harness/protocol";
import type { TicketedApprovalReview } from "../../../desktop/src/review-tickets.js";
export type {
  HarnessClientRun,
  HarnessClientSession,
  HarnessActivityPage,
  TicketedApprovalReview,
};
export interface WebWorkspace {
  key: string;
  name: string;
  workspace: string;
  provider: string;
  model: string;
}
export interface WebContext {
  csrf: string;
  workspaces: WebWorkspace[];
}
