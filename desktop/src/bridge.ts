import type { CatalogModel } from "../../src/internal/desktop/providers.js";
import type { HarnessClientResponse } from "../../src/internal/desktop/protocol.js";
import type { HarnessActivityPage } from "../../src/internal/desktop/protocol.js";
export interface DesktopModelSelection { provider: string; model: string }
export interface DesktopProvider { id: string; name: string; defaultModel: string; support: "certified" | "provisional"; models?: CatalogModel[]; catalogRevision?: string; catalogSource?: string; catalogStale?: boolean }
export interface DesktopProject { modelSelection?: DesktopModelSelection | undefined; key: string; workspace: string; name: string; lastOpenedAt: number }
export interface DesktopTask { id: string; sourceProjectKey: string; title: string; branch: string; baseCommit: string; workspace: string; status: "creating" | "ready" | "needs-attention" | "removed" }
export interface DesktopTaskRemoval { ticketId: string; task: DesktopTask; head: string; integrationCommit: string; changedPaths: string[]; unmergedCommits: number; locked: boolean; canRemove: boolean; expiresAt: number }
export interface DesktopContext { credentialConfigured?: boolean; modelSelection?: DesktopModelSelection | undefined; project: DesktopProject; projectId: string; runtimePid: number; runtimeNode: string; fixture: boolean; task?: DesktopTask }
export interface DesktopBridge {
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
    providers(): Promise<DesktopProvider[]>;
    selectModel(projectKey: string, selection: DesktopModelSelection): Promise<DesktopContext>;
    remoteTargets(projectKey: string): Promise<import("./github-git-transport.js").RemoteTargets>;
    reviewPush(projectKey: string, destination: import("./remote-delivery.js").PushDestination): Promise<import("./remote-delivery.js").PushReview>;
    push(projectKey: string, ticketId: string): Promise<import("./remote-delivery.js").PushOperation>;
    reconcilePush(projectKey: string, operationId: string): Promise<import("./remote-delivery.js").PushOperation | { id: string; status: "not-accepted" }>;
    gitChanges(projectKey: string): Promise<import("./git-delivery.js").DeliveryChanges>;
    gitStage(projectKey: string, paths: string[]): Promise<import("./git-delivery.js").DeliveryChanges>;
    gitReviewCommit(projectKey: string, input: { paths: string[]; message: string }): Promise<import("./git-delivery.js").CommitReview>;
    gitCommit(projectKey: string, ticketId: string): Promise<import("./git-delivery.js").CommitOperation>;
    gitReconcile(projectKey: string, operationId: string): Promise<import("./git-delivery.js").CommitReconciliation>;
    tasks(projectKey: string): Promise<DesktopTask[]>;
    createTask(projectKey: string, input: { title: string; branch?: string; initialState: "committed-head" }): Promise<DesktopTask>;
    openTask(taskId: string): Promise<DesktopContext>;
    reviewTaskRemoval(taskId: string): Promise<DesktopTaskRemoval>;
    removeTask(ticketId: string): Promise<DesktopTask>;
    resolveReview(projectKey: string, ticketId: string, approve: boolean): Promise<HarnessClientResponse>;
    review(projectKey: string, sessionId: string, runId: string): Promise<import("./review-tickets.js").TicketedApprovalReview>;
    projects(): Promise<DesktopProject[]>;
    chooseProject(): Promise<DesktopContext | null>;
    openProject(projectKey: string): Promise<DesktopContext>;
    initialProject(): Promise<DesktopContext | null>;
    command(projectKey: string, command: Record<string, unknown>): Promise<HarnessClientResponse>;
    events(projectKey: string, sessionId: string, after: number): Promise<HarnessActivityPage>;
}
declare global { interface Window { harness: DesktopBridge } }
