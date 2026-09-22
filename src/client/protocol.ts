import { type ApprovalDecisionView } from "../approvals/approval-history.js";
import { type ApprovalFilePreview } from "../approvals/approval-preview.js";
import { z } from "zod";
import type { AgentStreamEvent } from "@zhivex-ai/agents";
import { type CliSession } from "../persistence/sessions.js";

export const HARNESS_CLIENT_PROTOCOL_VERSION = 1 as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const revision = z.number().int().nonnegative().safe();

const scoped = { projectId: id };

const session = { ...scoped, sessionId: id };

const run = { ...session, runId: id };

const mutation = { idempotencyKey: id };

/** Strict command union; configuration, credentials and filesystem paths are host-owned. */
export const harnessClientCommandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("project.get"), ...scoped }).strict(),
  z.object({ method: z.literal("session.list"), ...scoped, search: z.string().max(256).optional() }).strict(),
  z.object({ method: z.literal("session.create"), ...scoped, ...mutation, title: z.string().max(256).optional() }).strict(),
  z.object({ method: z.literal("session.get"), ...session }).strict(),
  z.object({ method: z.literal("session.rename"), ...session, ...mutation, expectedRevision: revision, title: z.string().max(256) }).strict(),
  z.object({ method: z.literal("run.start"), ...session, ...mutation, expectedRevision: revision, prompt: z.string().min(1).max(64 * 1024) }).strict(),
  z.object({ method: z.literal("run.get"), ...run, includeReview: z.boolean().optional(), includeDiff: z.boolean().optional(), decisionOffset: z.number().int().min(0).max(512).optional() }).strict(),
  z.object({ method: z.literal("approval.resolve"), ...run, ...mutation, expectedRevision: revision,
    decisions: z.array(z.object({ approvalId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/), approve: z.boolean() }).strict()).min(1).max(64) }).strict(),
  z.object({ method: z.literal("run.cancel"), ...run, ...mutation, expectedRevision: revision }).strict()
]);

export const harnessClientRequestSchema = z.object({
  protocolVersion: z.literal(HARNESS_CLIENT_PROTOCOL_VERSION), requestId: id, connectionId: id,
  command: harnessClientCommandSchema
}).strict();

export type HarnessClientCommand = z.infer<typeof harnessClientCommandSchema>;

export type HarnessClientRequest = z.infer<typeof harnessClientRequestSchema>;

export type HarnessClientErrorCode = "INVALID_REQUEST" | "VERSION_UNSUPPORTED" | "CONNECTION_EXPIRED" | "NOT_FOUND" | "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "CAPACITY_EXCEEDED" | "APPROVAL_MISMATCH" | "INVALID_STATE" | "BUSY" | "EXECUTION_FAILED";

export interface HarnessClientSession extends CliSession {}

export interface HarnessClientRun {
  runId: string; revision: number; status: string; output: string; cliResult?: unknown; decisions?: ApprovalDecisionView[]; decisionTotal?: number; decisionNextOffset?: number;
  approvals: { approvalId: string; digest: string; provider: string; kind: string; action: unknown; expiresAt: number; filePreview?: ApprovalFilePreview }[];
}

export type HarnessClientData =
  | { kind: "project"; projectId: string }
  | { kind: "session"; session: HarnessClientSession }
  | { kind: "sessions"; sessions: HarnessClientSession[] }
  | { kind: "run"; session: HarnessClientSession; run: HarnessClientRun };

export type HarnessClientResponse = { protocolVersion: 1; requestId: string | null } & (
  | { ok: true; data: HarnessClientData }
  | { ok: false; error: { code: HarnessClientErrorCode } }
);

export type HarnessClientNegotiation =
  | { ok: true; protocolVersion: 1; connectionId: string; projectId: string; capabilities: readonly string[] }
  | { ok: false; error: { code: "VERSION_UNSUPPORTED" | "CONNECTION_EXPIRED" } };

export interface HarnessClientAdapterOptions {
  approvalMaxAgeMs?: number;
  now?: () => number;
  onPrompt?: (sessionId: string, runId: string, prompt: string) => void | Promise<void>;
  onEvent?: (sessionId: string, runId: string, event: AgentStreamEvent) => void | Promise<void>;
  onCheckpoint?: (sessionId: string, runId: string, status: string) => void | Promise<void>;
}

export interface HarnessClientAdapter {
  negotiate(versions: readonly number[]): HarnessClientNegotiation;
  dispatch(request: unknown): Promise<HarnessClientResponse>;
  /** Trusted host shutdown control; requests cancellation without finalizing effects. */
  cancelActive(): Promise<void>;
  /** Closes this connection and its session index, not the host-owned harness. */
  close(): void;
}

