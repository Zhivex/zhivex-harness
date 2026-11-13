/**
 * Stage-zero application boundary. These types describe the future host/client
 * adapter; they do not enable capabilities or implement a transport.
 * Keep this entrypoint browser-safe and independent of the Node host.
 */
import type {
  HarnessActivityPage,
  HarnessClientCommand,
  HarnessClientResponse,
  HarnessClientRun,
  HarnessClientSession,
} from "@zhivex-ai/harness/protocol";

export const ASSISTANT_APPLICATION_PROTOCOL_VERSION = 1 as const;
export type { HarnessActivityPage, HarnessActivityRun } from "@zhivex-ai/harness/protocol";

export interface AssistantFileView {
  path: string; digest: string; startLine: number; endLine: number; totalLines: number;
  content: string; clippedLine: boolean; truncated: boolean;
}
export interface AssistantFileList { files: { path: string }[]; nextCursor?: string; truncated: boolean }
export interface AssistantFileAttachment { path: string; digest: string; startLine: number; endLine: number }
export interface AssistantCommandOutput { id: string; name: string; status: string; command: string; stdout: string; stderr: string; exitCode?: number; truncated: boolean }

export type AssistantExecutionContext =
  | { kind: "general" }
  | { kind: "project"; projectKey: string }
  | { kind: "isolated-task"; projectKey: string; taskId: string };

/** Paths are display metadata, never authorization supplied by a renderer. */
export interface AssistantProject {
  projectKey: string;
  name: string;
  canonicalPath: string;
}

/** A binding is immutable. Context changes create a new conversation binding. */
export interface AssistantConversationBinding {
  conversationId: string;
  runtimeId: string;
  engineProjectId: string;
  sessionId: string;
  context: AssistantExecutionContext;
}

export type AssistantCapability =
  | "conversation" | "activity" | "cancel" | "effect-review"
  | "project-context" | "file-read" | "file-edit" | "command-execution"
  | "task-review" | "checkpoints" | "restore" | "worktrees" | "delegation";

export type AssistantCapabilityAvailability =
  | { available: true }
  | { available: false; reason: string };

/** All keys are explicit. A profile name alone never grants a capability. */
export interface AssistantCapabilities {
  context: AssistantExecutionContext;
  capabilities: Record<AssistantCapability, AssistantCapabilityAvailability>;
}

type WithoutProject<T> = T extends unknown ? Omit<T, "projectId"> : never;
/** These mutations require a trusted, concrete review receipt, not a raw command. */
export type AssistantReviewedEngineCommand = Extract<HarnessClientCommand, {
  method: "approval.resolve" | "restore.apply" | "restore.recoverFork";
}>;
export type AssistantApplicationEngineCommand = WithoutProject<Exclude<
  HarnessClientCommand, AssistantReviewedEngineCommand
>>;

/** The host resolves routing from conversationId and checks session/run membership. */
export interface AssistantCommandRequest {
  conversationId: string;
  command: AssistantApplicationEngineCommand;
}

export interface AssistantConversationSnapshot {
  binding: AssistantConversationBinding;
  capabilities: AssistantCapabilities;
  session: HarnessClientSession;
  runs: HarnessClientRun[];
}

/** Preserve engine cursor, snapshot, truncation and policy-evidence semantics. */
export interface AssistantActivityAttachment {
  binding: AssistantConversationBinding;
  page: HarnessActivityPage;
}

export type AssistantReviewTarget =
  | { kind: "effect"; runId: string }
  | { kind: "restore"; operationId: string }
  | { kind: "restore-recovery"; operationId: string; forkSessionId: string };

/**
 * The host stores the authoritative receipt, including scope, content identity,
 * revision and expiry. Clients cannot submit any of those as trusted authority.
 * Presentation remains the engine projection until a richer UI adapter is added.
 */
export interface AssistantReviewReceipt {
  ticketId: string;
  conversationId: string;
  target: AssistantReviewTarget;
  expiresAt: number;
  preview: { kind: 'effect'; review: TicketedApprovalReview } | { kind: 'restore'; review: CheckpointReview };
}

export type AssistantApplicationErrorCode =
  | "INVALID_REQUEST" | "VERSION_UNSUPPORTED" | "PROJECT_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND" | "CAPABILITY_UNAVAILABLE" | "RUNTIME_BUSY"
  | "OWNERSHIP_CONFLICT" | "BINDING_MISMATCH" | "REVIEW_STALE"
  | "EXECUTION_UNAVAILABLE"
  | "RECONCILIATION_REQUIRED" | "TRANSPORT_UNAVAILABLE";

export type AssistantApplicationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: AssistantApplicationErrorCode; message: string } };

/**
 * Proposed UI-independent API. Implementations must validate untrusted input,
 * negotiate version 1, authorize capabilities at the host and serialize mutations
 * there. TypeScript alone is not input validation or permission enforcement.
 */
export interface AssistantApplicationClient {
  readonly protocolVersion: typeof ASSISTANT_APPLICATION_PROTOCOL_VERSION;
  projects(): Promise<AssistantApplicationResult<AssistantProject[]>>;
  /** Single-use token from a trusted native/terminal selector; never a raw path. */
  registerProject(selection: { selectionToken: string }): Promise<AssistantApplicationResult<AssistantProject>>;
  conversations(): Promise<AssistantApplicationResult<AssistantConversationBinding[]>>;
  createConversation(input: { context: AssistantExecutionContext; title?: string; idempotencyKey: string }): Promise<AssistantApplicationResult<AssistantConversationBinding>>;
  snapshot(conversationId: string): Promise<AssistantApplicationResult<AssistantConversationSnapshot>>;
  command(request: AssistantCommandRequest): Promise<AssistantApplicationResult<HarnessClientResponse>>;
  attach(input: { conversationId: string; after: number }): Promise<AssistantApplicationResult<AssistantActivityAttachment>>;
  review(input: { conversationId: string; target: AssistantReviewTarget }): Promise<AssistantApplicationResult<AssistantReviewReceipt>>;
  decide(input: { conversationId: string; ticketId: string; approve: boolean; idempotencyKey: string }): Promise<AssistantApplicationResult<HarnessClientResponse>>;
}

export type { HarnessClientResponse, HarnessClientData, HarnessClientRun, HarnessClientSession } from '@zhivex-ai/harness/protocol';
export type HarnessTaskReview = Extract<import('@zhivex-ai/harness/protocol').HarnessClientData, { kind: 'taskReview' }>['review'];

export interface ApprovalReviewFile { path: string; expectedDigest: string | null; before?: string; after?: string; view: "literal-replacement" | "replacement-contents" | "operation" | "full-file"; afterDigest?: string | null; beforeMode?: number; afterMode?: number; operation?: "create" | "update" | "delete" | "restore" }
export interface ApprovalReviewItem {
    approvalId: string; digest: string; expiresAt: number; name: string; payloadDigest: string;
    payload: string; files: ApprovalReviewFile[]; commands: string[]; consequence: string;
    complete: boolean; restriction?: "REDACTED" | "TOO_LARGE" | "INVALID_PAYLOAD" | "BASE_UNAVAILABLE";
}
export interface ApprovalReview { schemaVersion: 1; runId: string; revision: number; status: string; items: ApprovalReviewItem[] }
import type { HarnessClientData } from '@zhivex-ai/harness/protocol';
type Restore = Extract<HarnessClientData, { kind: 'restore' }>;
export interface CheckpointReview {
  ticketId: string; operation: Restore['operation']; preview: Restore['preview']; canApply: boolean; redacted: boolean; expiresAt: number;
  recoverySessionId?: string;
  completionOnly?: boolean;
}
export type TicketedApprovalReview = ApprovalReview & { ticketId: string; canApprove: boolean };

export interface AssistantWorkItem { id: string; conversationId?: string; projectKey?: string; title: string; status: string; attention: boolean }
