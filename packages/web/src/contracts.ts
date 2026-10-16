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
  taskProtocol?: { connectionId: string; projectId: string; capabilities: readonly string[] };
  key: string;
  name: string;
  workspace: string;
  provider: string;
  model: string;
  /** Basename of this project's own tool policy. Absent when the project has none. */
  toolPolicy?: string;
  unavailable?: boolean;
  cause?: string;
}
export interface WebContext {
  csrf: string;
  workspaces: WebWorkspace[];
}
export interface WebModelChoice {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  configured: boolean;
  capabilities: string[];
  validation: string;
  group?: "primary" | "other";
  order?: number;
  /** Present only when the catalog publishes a context window. */
  contextWindow?: { tokens: number; type: "combined" | "input" };
  /** Present only when the catalog publishes a USD price. */
  cost?: { currency: "USD"; inputPerMillionTokens: number; outputPerMillionTokens: number };
}
export interface WebPendingReview {
  sessionId: string;
  title?: string;
  runId: string;
  expiresAt?: number;
}
export interface WebProjectOverview {
  key: string;
  name: string;
  pending: WebPendingReview[];
  unavailable?: boolean;
  cause?: string;
  readError?: string;
}
export interface WebModelSelection {
  provider: string;
  model: string;
}
