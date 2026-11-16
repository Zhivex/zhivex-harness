import type {AssistantSetupState, CodeProjectState, ApplicationCatalogSnapshot} from '@zhivex-ai/harness/application/protocol';
export type {AssistantSetupState} from '@zhivex-ai/harness/application/protocol';
import type { HarnessActivityPage, HarnessClientResponse } from "@zhivex-ai/harness/protocol";
import type { TicketedApprovalReview, CheckpointReview, ManagedTask, TaskRemovalReview } from "@zhivex-ai/harness/application";

export interface UnifiedHost { id: string; area: "assistant" | "code"; label: string; projectId: string }
export type GitBridge = Pick<import("../bridge.js").DesktopBridge, "gitChanges" | "gitStage" | "gitReviewCommit" | "gitCommit" | "gitReconcile" | "remoteTargets" | "reviewPush" | "push" | "reconcilePush" | "reviewPr" | "createPr" | "reconcilePr" | "openPr">;
export interface UnifiedBridge extends GitBridge {
  catalog(): Promise<ApplicationCatalogSnapshot | null>;
  agenda(projectId: string, date: string, timeZone: string): Promise<import('@zhivex-ai/harness/application/protocol').AgendaSnapshot>;
  automation(projectId: string, change?: import('@zhivex-ai/harness/application/protocol').AutomationChange): Promise<import('@zhivex-ai/harness/application/protocol').AutomationSnapshot>;
  notes(projectId: string, options: {query?: string; offset?: number; noteId?: string}): Promise<import('@zhivex-ai/harness/application/protocol').NotesSnapshot>;
  prepareReplyWatch(projectId: string, watch: {requestId: string; source: 'google' | 'microsoft'; threadId: string; baselineMessageId: string; expectedFrom: string; title: string; dueAt: string}): Promise<{requestId: string; proposalDigest: string}>;
  prepareMailDraft(projectId: string, provider: 'google' | 'microsoft', draft: {requestId: string; to: string[]; subject: string; body: string}): Promise<{requestId: string; proposalDigest: string}>;
  prepareCalendarCreation(projectId: string, event: {requestId: string; summary: string; start: string; end: string; attendees: string[]}): Promise<{operationId: string; proposalDigest: string}>;
  personalState(projectId: string, offset?: number): Promise<import('@zhivex-ai/harness/application/protocol').PersonalSnapshot>;
  openCalendarAuthorization(): Promise<void>;
  openTelegram(): Promise<void>;
  setupState(): Promise<AssistantSetupState | null>;
  setupAction(name: string, value: unknown): Promise<AssistantSetupState>;
  codeState(): Promise<CodeProjectState | null>;
  openCode(connectionId: string): Promise<CodeProjectState | null>;
  configureCode(id: string, connectionId: string): Promise<CodeProjectState>;
  selectCode(id: string): Promise<CodeProjectState>;
  retryCode(): Promise<CodeProjectState>;
  worktrees(): Promise<ManagedTask[]>;
  createWorktree(input: {title: string; branch?: string; initialState: 'committed-head'}): Promise<ManagedTask>;
  openWorktree(id: string): Promise<void>;
  reviewWorktreeRemoval(id: string): Promise<TaskRemovalReview>;
  removeWorktree(ticketId: string): Promise<ManagedTask>;
  codeContext(projectId: string): Promise<import('@zhivex-ai/harness/application/protocol').CodeContextSnapshot>;
  checks(): Promise<{name: string; script: string; argv: string[]}[]>;
  reviewCheckpoint(hostId: string, sessionId: string, operationId: string): Promise<CheckpointReview>;
  reviewCheckpointRecovery(hostId: string, sessionId: string, operationId: string, forkSessionId: string): Promise<CheckpointReview>;
  resolveCheckpointReview(hostId: string, ticketId: string, approve: boolean): Promise<HarnessClientResponse | null>;
  hosts(): Promise<UnifiedHost[]>;
  reconnect(hostId: string): Promise<void>;
  command(hostId: string, command: Record<string, unknown>): Promise<HarnessClientResponse>;
  events(hostId: string, sessionId: string, after: number): Promise<HarnessActivityPage>;
  review(hostId: string, sessionId: string, runId: string): Promise<TicketedApprovalReview>;
  decide(hostId: string, ticketId: string, approve: boolean): Promise<HarnessClientResponse>;
}
declare global { interface Window { zhivex: UnifiedBridge } }
