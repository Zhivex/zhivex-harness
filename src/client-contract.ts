/** Experimental in-process client protocol. No transport or terminal dependencies. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentRunState, AgentStreamEvent } from "@zhivex-ai/agents";
import { appendUserMessage, runHarness, type ZhivexHarness } from "./harness.js";
import { cancelHarnessRun } from "./operations.js";
import { openCliSessionStore, type CliSession, type CliSessionStore, SESSION_RUN_STATUSES, type SessionRunStatus } from "./sessions.js";
import { HarnessStateConflictError } from "./errors.js";

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
  z.object({ method: z.literal("run.get"), ...run }).strict(),
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
export interface HarnessClientSession {
  sessionId: string; revision: number; title?: string; runs: { runId: string; status: string }[];
}
export interface HarnessClientRun {
  runId: string; revision: number; status: string; output: string;
  approvals: { approvalId: string; digest: string; provider: string; kind: string; action: unknown; expiresAt: number }[];
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
  onEvent?: (sessionId: string, runId: string, event: AgentStreamEvent) => void | Promise<void>;
  onCheckpoint?: (sessionId: string, runId: string, status: string) => void | Promise<void>;
}
export interface HarnessClientAdapter {
  negotiate(versions: readonly number[]): HarnessClientNegotiation;
  dispatch(request: unknown): Promise<HarnessClientResponse>;
  /** Closes this connection and its session index, not the host-owned harness. */
  close(): void;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
class ClientFault extends Error { constructor(readonly code: HarnessClientErrorCode) { super(code); } }
const fail = (code: HarnessClientErrorCode): never => { throw new ClientFault(code); };
const sessionStatus = (status: string): SessionRunStatus => {
  if (!(SESSION_RUN_STATUSES as readonly string[]).includes(status)) return fail("INVALID_STATE");
  return status as SessionRunStatus;
};
const sessionDocument = (value: CliSession): HarnessClientSession => ({ sessionId: value.sessionId, revision: value.revision,
  ...(value.title === undefined ? {} : { title: value.title }), runs: value.runs.map(r => ({ runId: r.runId, status: r.status })) });
const runDocument = (state: AgentRunState, approvalMaxAgeMs: number): HarnessClientRun => ({ runId: state.runId, revision: state.revision ?? 0,
  status: state.status, output: state.outputText ?? "", approvals: state.pendingApprovals.map(a => ({
    approvalId: a.id, expiresAt: (state.updatedAt ?? state.startedAt ?? 0) + approvalMaxAgeMs, provider: a.provider, kind: a.kind ?? "provider", digest: digest(a), action: a
  })) });

/** One trusted host, one workspace/scope, one connection epoch; no multi-writer guarantee. */
export const createHarnessClientAdapter = async (harness: ZhivexHarness, options: HarnessClientAdapterOptions = {}): Promise<HarnessClientAdapter> => {
  const approvalMaxAgeMs = options.approvalMaxAgeMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(approvalMaxAgeMs) || approvalMaxAgeMs < 1) throw new Error("APPROVAL_TTL_INVALID");
  const documentRun = (state: AgentRunState) => runDocument(state, approvalMaxAgeMs);
  const sessions: CliSessionStore = await openCliSessionStore({ workspace: harness.config.workspace,
    stateDirectory: harness.config.stateDirectory, scope: harness.config.scope });
  const projectId = `project_${digest([sessions.workspaceKey, sessions.scopeKey])}`;
  const connectionId = `connection_${randomUUID()}`;
  let closed = false, busy = false;
  let active: { sessionId: string; runId: string; controller: AbortController } | undefined;
  const invoke = async (sessionId: string, input: Parameters<typeof runHarness>[1]) => {
    const runId = "state" in input ? input.state.runId : input.runId!;
    const controller = new AbortController(); active = { sessionId, runId, controller };
    try {
      const result = await runHarness(harness, { ...input, abortSignal: controller.signal }, {
        onEvent: event => options.onEvent?.(sessionId, runId, event)
      });
      await options.onCheckpoint?.(sessionId, runId, result.state.status);
      return result;
    } catch (e) {
      await options.onCheckpoint?.(sessionId, runId, "interrupted");
      throw e;
    } finally { active = undefined; }
  };
  const receipts = new Map<string, { fingerprint: string; response: Promise<HarnessClientResponse> }>();
  const getSession = async (sessionId: string) => {
    const found = await sessions.get(sessionId);
    if (!found || found.archivedAt || found.deletedAt) return fail("NOT_FOUND");
    return found;
  };
  const getRun = async (s: CliSession, runId: string) => {
    if (!s.runs.some(r => r.runId === runId)) return fail("NOT_FOUND");
    const found = await harness.store.load(runId, harness.config.scope);
    if (!found) return fail("INVALID_STATE");
    return found;
  };
  const refresh = async (s: CliSession) => {
    for (const ref of s.runs) {
      const state = await getRun(s, ref.runId);
      if (ref.status !== state.status) s = await sessions.updateRun(s.sessionId, ref.runId, { status: sessionStatus(state.status) });
    }
    return s;
  };
  const execute = async (c: HarnessClientCommand): Promise<HarnessClientData> => {
    if (c.projectId !== projectId) return fail("NOT_FOUND");
    if (c.method === "project.get") return { kind: "project", projectId };
    if (c.method === "session.create") return { kind: "session", session: sessionDocument(await sessions.create(c.title === undefined ? {} : { title: c.title })) };
    if (c.method === "session.list") {
      const listed = await sessions.list(c.search === undefined ? {} : { search: c.search });
      const result = [];
      for (const s of listed) result.push(sessionDocument(await refresh(await getSession(s.sessionId))));
      return { kind: "sessions", sessions: result };
    }
    let s = await refresh(await getSession(c.sessionId));
    if (c.method === "session.get") return { kind: "session", session: sessionDocument(s) };
    if (c.method === "session.rename" || c.method === "run.start") {
      if (s.revision !== c.expectedRevision) return fail("REVISION_CONFLICT");
      if (c.method === "session.rename") return { kind: "session", session: sessionDocument(await sessions.rename(s.sessionId, c.title, { expectedRevision: c.expectedRevision })) };
      const last = s.runs.at(-1);
      const previous = last ? await getRun(s, last.runId) : undefined;
      if (previous && !["completed", "failed", "cancelled", "timed_out"].includes(previous.status)) return fail("INVALID_STATE");
      const runId = `run_${randomUUID()}`;
      s = await sessions.appendRun(s.sessionId, { runId, provider: harness.config.provider, model: harness.config.model, status: "created" }, { expectedRevision: c.expectedRevision });
      const result = await invoke(s.sessionId, { runId, messages: appendUserMessage(previous?.messages ?? [], c.prompt) });
      s = await sessions.updateRun(s.sessionId, runId, { status: sessionStatus(result.state.status) });
      return { kind: "run", session: sessionDocument(s), run: documentRun(result.state) };
    }
    let state = await getRun(s, c.runId);
    if (c.method === "run.get") return { kind: "run", session: sessionDocument(s), run: documentRun(state) };
    if ((state.revision ?? 0) !== c.expectedRevision) return fail("REVISION_CONFLICT");
    if (c.method === "run.cancel") {
      if (["created", "running", "cancel_requested"].includes(state.status)) return fail("INVALID_STATE");
      if (!["completed", "failed", "cancelled", "timed_out"].includes(state.status)) {
        await cancelHarnessRun(harness.store, harness.config, state.runId, { final: true, cascade: true });
        state = await getRun(s, state.runId);
      }
    } else {
      if (state.status !== "waiting_approval") return fail("INVALID_STATE");
      if ((options.now ?? Date.now)() > (state.updatedAt ?? state.startedAt ?? 0) + approvalMaxAgeMs) return fail("APPROVAL_MISMATCH");
      const pending = state.pendingApprovals;
      if (c.decisions.length !== pending.length || new Set(c.decisions.map(d => d.approvalId)).size !== pending.length) return fail("APPROVAL_MISMATCH");
      const approvals = c.decisions.map(d => {
        const a = pending.find(a => a.id === d.approvalId);
        if (!a || digest(a) !== d.digest) return fail("APPROVAL_MISMATCH");
        return { provider: a.provider, approvalRequestId: a.id, approve: d.approve };
      });
      state = (await invoke(s.sessionId, { state, approvals })).state;
    }
    s = await sessions.updateRun(s.sessionId, state.runId, { status: sessionStatus(state.status) });
    return { kind: "run", session: sessionDocument(s), run: documentRun(state) };
  };
  return {
    negotiate(versions) {
      if (closed) return { ok: false, error: { code: "CONNECTION_EXPIRED" } };
      if (!versions.includes(1)) return { ok: false, error: { code: "VERSION_UNSUPPORTED" } };
      return { ok: true, protocolVersion: 1, connectionId, projectId, capabilities: ["project.get", "session.list", "session.create", "session.get", "session.rename", "run.start", "run.get", "approval.resolve", "run.cancel.checkpoint", "run.cancel.active", "idempotency.connection", "revision.precondition"] };
    },
    async dispatch(value) {
      const parsed = harnessClientRequestSchema.safeParse(value);
      if (!parsed.success) return { protocolVersion: 1, requestId: null, ok: false, error: { code: "INVALID_REQUEST" } };
      const request = parsed.data;
      const error = (code: HarnessClientErrorCode): HarnessClientResponse => ({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code } });
      if (closed || request.connectionId !== connectionId) return error("CONNECTION_EXPIRED");
      const c = request.command;
      const key = "idempotencyKey" in c ? c.idempotencyKey : undefined;
      const fingerprint = digest(c);
      const existing = key ? receipts.get(key) : undefined;
      if (existing) return existing.fingerprint === fingerprint ? { ...structuredClone(await existing.response), requestId: request.requestId } : error("IDEMPOTENCY_CONFLICT");
      if (busy) {
        if (c.method === "run.cancel" && c.projectId === projectId && active?.runId === c.runId && active.sessionId === c.sessionId) {
          if (key && receipts.size >= 1024) return error("CAPACITY_EXCEEDED");
          const cancellation = (async (): Promise<HarnessClientResponse> => {
            try {
              const s = await getSession(c.sessionId); const state = await getRun(s, c.runId);
              if ((state.revision ?? 0) !== c.expectedRevision) return error("REVISION_CONFLICT");
              const controller = active?.controller;
              await cancelHarnessRun(harness.store, harness.config, c.runId, { cascade: true });
              controller?.abort();
              const latest = await getRun(s, c.runId);
              await options.onCheckpoint?.(s.sessionId, c.runId, latest.status);
              return { protocolVersion: 1, requestId: request.requestId, ok: true, data: { kind: "run", session: sessionDocument(s), run: documentRun(latest) } };
            } catch { return error("EXECUTION_FAILED"); }
          })();
          if(key) receipts.set(key, { fingerprint, response: cancellation });
          return structuredClone(await cancellation);
        }
        if (c.method === "run.get" && c.projectId === projectId) {
          try { const s = await getSession(c.sessionId); const state = await getRun(s, c.runId); return { protocolVersion: 1, requestId: request.requestId, ok: true, data: { kind: "run", session: sessionDocument(s), run: documentRun(state) } }; }
          catch { return error("NOT_FOUND"); }
        }
        return error(c.method === "approval.resolve" ? "REVISION_CONFLICT" : "BUSY");
      }
      if (key && receipts.size >= 1024) return error("CAPACITY_EXCEEDED");
      busy = true;
      const response = (async (): Promise<HarnessClientResponse> => {
        try { return { protocolVersion: 1, requestId: request.requestId, ok: true, data: await execute(c) }; }
        catch (e) { return error(e instanceof ClientFault ? e.code : e instanceof HarnessStateConflictError ? "REVISION_CONFLICT" : "EXECUTION_FAILED"); }
        finally { busy = false; }
      })();
      if (key) receipts.set(key, { fingerprint, response });
      return structuredClone(await response);
    },
    close() { if (closed) return; if (busy) return fail("BUSY"); closed = true; sessions.close(); receipts.clear(); }
  };
};
