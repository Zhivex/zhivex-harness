import { observeHarnessPolicyDecisions, createPolicyDecisionEvidence } from "../runtime/policy-decisions.js";
import { inspectHarnessPolicy } from "../runtime/policy-inspection.js";
import {
  APPROVAL_HISTORY_KEY,
  approvalDecisionViews,
  approvalInputDigest,
  readApprovalDecisions,
  type ApprovalDecisionRecord
} from "../approvals/approval-history.js";
import { APPROVAL_DIFFS_KEY, captureApprovalDiffs, attachAppliedDiffs } from "../approvals/approval-diff.js";
import { terminalContinuationMessages } from "./continuation.js";
import { ASSISTANT_RESPONSE_KEY, assistantResponses } from "../context/task-memory.js";
import { attachApprovalPreviews } from "../approvals/approval-preview.js";
import { hostPolicyIdentity, requiresExplicitHostReview } from "../approvals/host-policy-identity.js";
import { issueExplicitReviewResponses, issueRecordedApprovalResponses } from "../approvals/explicit-review.js";
import { createHash, randomUUID } from "node:crypto";
import type { AgentRunState } from "@zhivex-ai/agents";
import { appendUserMessage, runHarness, type ZhivexHarness } from "../runtime/harness.js";
import { cancelHarnessRun } from "../persistence/operations.js";
import {
  openCliSessionStore,
  type CliSession,
  type CliSessionStore,
  SESSION_RUN_STATUSES,
  type SessionRunStatus
} from "../persistence/sessions.js";
import { runResultDocument } from "./run-document.js";
import { HarnessStateConflictError, harnessErrorDocument, providerStreamDiagnostic } from "../runtime/errors.js";
import { openWorkspaceCheckpointStore, type WorkspaceRestoreOperation } from '../persistence/workspace-checkpoints.js';
import {
  harnessClientRequestSchema,
  type HarnessClientAdapter,
  type HarnessClientAdapterOptions,
  type HarnessClientCommand,
  type HarnessClientData,
  type HarnessClientErrorCode,
  type HarnessClientResponse,
  type HarnessClientRun,
  type HarnessClientSession
} from "./protocol.js";

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

const sessionDocument = (value: CliSession): HarnessClientSession => structuredClone(value);

const runDocument = (state: AgentRunState, approvalMaxAgeMs: number): HarnessClientRun => ({ runId: state.runId, revision: state.revision ?? 0,
  status: state.status, output: state.outputText ?? "",
  ...(state.status === "failed" && state.error ? { error: harnessErrorDocument({ ...state.error,
    ...(state.metadata?.clientProviderStreamDiagnostic ? { ...state.metadata.clientProviderStreamDiagnostic as object, category: "provider-stream" } : {}) }).error } : {}), ...(state.metadata?.clientCliResultV1 ? {cliResult:state.metadata.clientCliResultV1}:{}), approvals: state.pendingApprovals.map(a => ({
    approvalId: a.id, expiresAt: (state.updatedAt ?? state.startedAt ?? 0) + approvalMaxAgeMs, provider: a.provider, kind: a.kind ?? "provider", digest: digest(a), action: a
  })) });

/** Trusted host lifecycle hook; never accepted from a protocol request. */
export interface HarnessClientRunRuntimeOptions {
  prepareRun?(context: { sessionId: string; runId: string; resuming: boolean; signal: AbortSignal }): Promise<{
    harness: ZhivexHarness;
    release(): Promise<void>;
  }>;
}

/** One trusted host, one workspace/scope, one connection epoch; no multi-writer guarantee. */
export const createHarnessClientAdapter = async (harness: ZhivexHarness, options: HarnessClientAdapterOptions & HarnessClientRunRuntimeOptions = {}): Promise<HarnessClientAdapter> => {
  const approvalMaxAgeMs = options.approvalMaxAgeMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(approvalMaxAgeMs) || approvalMaxAgeMs < 1) throw new Error("APPROVAL_TTL_INVALID");
  const documentRun = async (state: AgentRunState,offset=0,includeDiff=false): Promise<HarnessClientRun> => {
    const total=readApprovalDecisions(state).length;
    const decisions=approvalDecisionViews(state,await harness.store.listToolCalls?.(state.runId,harness.config.scope)??[],offset);
    return {...runDocument(state,approvalMaxAgeMs),decisions:includeDiff?attachAppliedDiffs(state,decisions):decisions,decisionTotal:total,...(offset+25<total?{decisionNextOffset:offset+25}:{})};
  };
  const sessions: CliSessionStore = await openCliSessionStore({ workspace: harness.config.workspace,
    stateDirectory: harness.config.stateDirectory, scope: harness.config.scope });
  const projectId = `project_${digest([sessions.workspaceKey, sessions.scopeKey])}`;
  const connectionId = `connection_${randomUUID()}`;
  let checkpoints: Awaited<ReturnType<typeof openWorkspaceCheckpointStore>> | undefined;
  const checkpointStore = async () => checkpoints ??= await openWorkspaceCheckpointStore(harness.workspace, sessions);
  const restoreDocument = async (operation: WorkspaceRestoreOperation): Promise<Extract<HarnessClientData, { kind: 'restore' }>> => {
    let preview: Extract<HarnessClientData, { kind: 'restore' }>['preview'] = { status: 'unavailable' };
    try { preview = { status: 'available', diff: await (await checkpointStore()).previewRestore(operation.id) }; } catch { /* Stale/missing bases are shown explicitly. */ }
    return { kind: 'restore', operation: { id: operation.id, checkpointId: operation.checkpoint.id,
      proposalId: operation.proposalId, stage: operation.stage,
      ...(operation.forkSessionId ? { forkSessionId: operation.forkSessionId } : {}) }, preview };
  };
  let closed = false, busy = false;
  let active: { sessionId: string; runId: string; controller: AbortController; runtime?: ZhivexHarness } | undefined;
  const invoke = async (sessionId: string, input: Parameters<typeof runHarness>[1], prompt?: string) => {
    const runId = "state" in input ? input.state.runId : input.runId!;
    const controller = new AbortController(); active = { sessionId, runId, controller };
    let prepared: Awaited<ReturnType<NonNullable<HarnessClientRunRuntimeOptions['prepareRun']>>> | undefined;
    try {
      if (prompt !== undefined) await options.onPrompt?.(sessionId, runId, prompt);
      prepared = await options.prepareRun?.({ sessionId, runId, resuming: 'state' in input, signal: controller.signal });
      const runtime = prepared?.harness ?? harness;
      if (runtime.store !== harness.store || runtime.workspace.root !== harness.workspace.root || canonical(runtime.config) !== canonical(harness.config)) {
        throw new Error('CLIENT_RUNTIME_BINDING_MISMATCH');
      }
      if (controller.signal.aborted) throw new Error('CLIENT_RUNTIME_PREPARATION_CANCELLED');
      active.runtime = runtime;
      const mutationOffset = runtime.workspace.mutationAudit().length;
      const policyEvidence = createPolicyDecisionEvidence();
      const result = await observeHarnessPolicyDecisions(async event => { policyEvidence.append(event); await options.onPolicyDecision?.(sessionId, runId, event); }, () => runHarness(runtime, { ...input, abortSignal: controller.signal }, {
        onEvent: event => options.onEvent?.(sessionId, runId, event)
      }));
      const document = { ...runResultDocument(result, runtime), policyEvidence: policyEvidence.snapshot(), mutations: runtime.workspace.mutationAudit().slice(mutationOffset) };
      const latest = { ...result.state, metadata: { ...result.state.metadata, clientCliResultV1: JSON.parse(JSON.stringify(document)) } };
      await harness.store.save(latest, { expectedRevision: result.state.revision ?? 0 });
      const saved = await harness.store.load(runId, harness.config.scope);
      if (!saved) throw new Error("CLIENT_RESULT_STATE_MISSING");
      await options.onCheckpoint?.(sessionId, runId, saved.status);
      return { ...result, state: saved };
    } catch (e) {
      let persisted: AgentRunState | undefined;
      try {
        persisted = await harness.store.load(runId, harness.config.scope);
        if (!persisted && !('state' in input)) {
          // Keep failed prompt recording or preparation from stranding the session's
          // already-reserved run reference. No model or tool ran in this state.
          const now = Date.now();
          await harness.store.save({ schemaVersion: 1, revision: 0, runId, scope: harness.config.scope,
            provider: harness.agent.model.provider, modelId: harness.agent.model.modelId,
            status: controller.signal.aborted ? 'cancelled' : 'failed', messages: input.messages ?? [], steps: [], toolResults: [],
            currentStep: 0, maxSteps: harness.config.budget.unlimitedSteps ? "unlimited" : harness.config.maxSteps, outputText: '', pendingApprovals: [], startedAt: now, updatedAt: now,
            error: { message: 'Run stopped before initialization.' } });
          persisted = await harness.store.load(runId, harness.config.scope);
        }
      } catch { /* Preserve the original failure if the store itself is unavailable. */ }
      const diagnostic = providerStreamDiagnostic(e);
      // Preserve safe fields even with an installed SDK that only persisted message.
      // The SDK owns parser behavior; this compatibility receipt only projects its error.
      if (diagnostic && persisted?.status === "failed") {
        try {
          await harness.store.save({ ...persisted, metadata: { ...persisted.metadata, clientProviderStreamDiagnostic: { ...diagnostic } } }, { expectedRevision: persisted.revision ?? 0 });
        } catch { /* Preserve the original provider failure if receipt persistence fails. */ }
      }
      await options.onCheckpoint?.(sessionId, runId, persisted?.status ?? "interrupted");
      throw e;
    } finally { try { await prepared?.release(); } finally { active = undefined; } }
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
  const reviewedRequests = new WeakSet<object>();
  const execute = async (c: HarnessClientCommand, hostReviewed = false): Promise<HarnessClientData> => {
    if (c.projectId !== projectId) return fail("NOT_FOUND");
    if (c.method === "project.get") return { kind: "project", projectId };
    if (c.method === "policy.get") return { kind: "policy", policy: inspectHarnessPolicy(active?.runtime ?? harness) };
    if (c.method === "session.create") return { kind: "session", session: sessionDocument(await sessions.create(c.title === undefined ? {} : { title: c.title })) };
    if (c.method === "session.list") {
      const listed = await sessions.list(c.search === undefined ? {} : { search: c.search });
      const result = [];
      for (const s of listed) result.push(sessionDocument(await refresh(await getSession(s.sessionId))));
      return { kind: "sessions", sessions: result };
    }
    let s = await refresh(await getSession(c.sessionId));
    if (c.method === "session.get") return { kind: "session", session: sessionDocument(s) };
    if (c.method === 'checkpoint.list') {
      const store = await checkpointStore();
      return { kind: 'checkpoints', checkpoints: store.listCheckpoints(s.sessionId), restores: store.listRestores(s.sessionId) };
    }
    if (c.method === 'checkpoint.capture') {
      if (s.revision !== c.expectedRevision) return fail('REVISION_CONFLICT');
      const store = await checkpointStore();
      const checkpoint = await store.capture({ sessionId: s.sessionId, turnId: c.turnId, paths: c.paths });
      return { kind: 'checkpoint', inspection: await store.inspectCheckpoint(checkpoint.id) };
    }
    if (c.method === 'checkpoint.inspect' || c.method === 'restore.prepare') {
      const store = await checkpointStore();
      if (store.getCheckpoint(c.checkpointId).sessionId !== s.sessionId) return fail('NOT_FOUND');
      if (c.method === 'checkpoint.inspect') return { kind: 'checkpoint', inspection: await store.inspectCheckpoint(c.checkpointId) };
      if (s.revision !== c.expectedRevision) return fail('REVISION_CONFLICT');
      return restoreDocument((await store.prepareRestore(c.checkpointId, c.expected)).operation);
    }
    if (c.method === 'restore.get' || c.method === 'restore.apply' || c.method === 'restore.recoverFork') {
      const store = await checkpointStore();
      const operation = store.getOperation(c.operationId);
      if (operation.checkpoint.sessionId !== s.sessionId) return fail('NOT_FOUND');
      if (c.method === 'restore.get') return restoreDocument(operation);
      if (s.revision !== c.expectedRevision) return fail('REVISION_CONFLICT');
      // Never mutate files while this conversation has an unfinished durable run.
      if (s.runs.some(run => !['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status))) return fail('INVALID_STATE');
      if (c.method === 'restore.recoverFork') return restoreDocument(await store.recoverFork(operation.id, c.forkSessionId));
      const complete = await store.applyRestore(operation.id, c.reviewedProposalId);
      const fork = await getSession(complete.forkSessionId!);
      return { ...await restoreDocument(complete), session: sessionDocument(fork) };
    }
    if (c.method === "session.rename" || c.method === "run.start") {
      if (s.revision !== c.expectedRevision) return fail("REVISION_CONFLICT");
      if (c.method === "session.rename") return { kind: "session", session: sessionDocument(await sessions.rename(s.sessionId, c.title, { expectedRevision: c.expectedRevision })) };
      const last = s.runs.at(-1);
      const previous = last ? await getRun(s, last.runId) : undefined;
      if (previous && !["completed", "failed", "cancelled", "timed_out"].includes(previous.status)) return fail("INVALID_STATE");
      const runId = `run_${randomUUID()}`;
      s = await sessions.appendRun(s.sessionId, { runId, provider: harness.config.provider, model: harness.config.model, status: "created" }, { expectedRevision: c.expectedRevision });
      const result = await invoke(s.sessionId, { runId, scope: harness.config.scope,
        // getRun above binds the previous run to this exact session and scope.
        // Carry only bounded assistant context, never approval/acceptance metadata.
        metadata: { [ASSISTANT_RESPONSE_KEY]: assistantResponses(previous?.metadata) },
        messages: appendUserMessage(terminalContinuationMessages(previous?.messages ?? []), c.prompt) }, c.prompt);
      s = await sessions.updateRun(s.sessionId, runId, { status: sessionStatus(result.state.status) });
      return { kind: "run", session: sessionDocument(s), run: await documentRun(result.state) };
    }
    let state = await getRun(s, c.runId);
    if (c.method === "run.get") return { kind: "run", session: sessionDocument(s), run: c.includeReview ? await attachApprovalPreviews(await documentRun(state,c.decisionOffset,c.includeDiff), harness.workspace,{environment:harness.executionEnvironment,scope:harness.config.scope}) : await documentRun(state,c.decisionOffset,c.includeDiff) };
    if ((state.revision ?? 0) !== c.expectedRevision) return fail("REVISION_CONFLICT");
    if (c.method === "run.cancel") {
      if (["created", "running", "queued", "cancel_requested"].includes(state.status)) {
        // An idle adapter may be reopening a crashed worker's run. A persisted
        // running status alone does not prove that its execution lease is dead.
        const ownerId = `cancel_${randomUUID()}`;
        if (!harness.store.acquireLease || !harness.store.releaseLease) return fail("INVALID_STATE");
        if (!await harness.store.acquireLease(state.runId, { ownerId, ttlMs: 30_000 }, harness.config.scope)) return fail("BUSY");
        try {
          state = await getRun(s, state.runId);
          if ((state.revision ?? 0) !== c.expectedRevision) return fail("REVISION_CONFLICT");
          // Descendants may still own independent leases: request their stop,
          // but only finalize the parent whose lease we actually hold.
          const visited = new Set([state.runId]);
          const requestChildren = async (parentRunId: string): Promise<void> => {
            for (const child of await harness.store.findByParentRunId?.(parentRunId, harness.config.scope) ?? []) {
              if (visited.has(child.runId)) continue;
              visited.add(child.runId);
              await requestChildren(child.runId);
              if (!["completed", "failed", "cancelled", "timed_out"].includes(child.status)) {
                await cancelHarnessRun(harness.store, harness.config, child.runId);
              }
            }
          };
          await requestChildren(state.runId);
          await cancelHarnessRun(harness.store, harness.config, state.runId, { final: true });
          state = await getRun(s, state.runId);
        } finally {
          await harness.store.releaseLease(state.runId, ownerId, harness.config.scope);
        }
      }
      if (!["completed", "failed", "cancelled", "timed_out"].includes(state.status)) {
        await cancelHarnessRun(harness.store, harness.config, state.runId, { final: true, cascade: true });
        state = await getRun(s, state.runId);
      }
      await options.onCheckpoint?.(s.sessionId, state.runId, state.status);
    } else {
      if (state.status !== "waiting_approval") return fail("INVALID_STATE");
      const explicitPositive = requiresExplicitHostReview(harness) && c.decisions.some(decision => decision.approve);
      if (explicitPositive && !hostReviewed) return fail('EXPLICIT_REVIEW_REQUIRED');
      if ((options.now ?? Date.now)() > (state.updatedAt ?? state.startedAt ?? 0) + approvalMaxAgeMs) return fail("APPROVAL_MISMATCH");
      const pending = state.pendingApprovals;
      if (c.decisions.length !== pending.length || new Set(c.decisions.map(d => d.approvalId)).size !== pending.length) return fail("APPROVAL_MISMATCH");
      const approvals = c.decisions.map(d => {
        const a = pending.find(a => a.id === d.approvalId);
        if (!a || digest(a) !== d.digest) return fail("APPROVAL_MISMATCH");
        return { provider: a.provider, approvalRequestId: a.id, approve: d.approve };
      });
      const history=readApprovalDecisions(state);
      if(history.length+c.decisions.length>512)return fail("CAPACITY_EXCEEDED");
      if(c.decisions.some(d=>history.some(row=>row.approvalId===d.approvalId&&row.digest===d.digest)))return fail("APPROVAL_MISMATCH");
      const recorded:ApprovalDecisionRecord[]=c.decisions.map(d=>{
        const a=pending.find(a=>a.id===d.approvalId)!;
        let inputDigest:string|undefined;try{inputDigest=approvalInputDigest(JSON.parse(a.arguments));}catch{}
        return {approvalId:d.approvalId,digest:d.digest,name:a.name,approved:d.approve,decidedAt:(options.now??Date.now)(),reviewedRevision:c.expectedRevision,
          provenance:{schemaVersion:1,origin:hostReviewed?'interactive':'application',channel:hostReviewed?'desktop-host':'client-protocol-v1',policyDigest:hostPolicyIdentity(harness)},
          ...(a.toolCallId?{toolCallId:a.toolCallId}:{}),...(inputDigest?{inputDigest}:{})};
      });
      // Commit intent before executing. Crash recovery must not authorize a second decision.
      const approvedIds=new Set(c.decisions.filter(decision=>decision.approve).map(decision=>decision.approvalId));
      const toArchive=runDocument(state,approvalMaxAgeMs);toArchive.approvals=toArchive.approvals.filter(approval=>approvedIds.has(approval.approvalId));
      const reviewed=await attachApprovalPreviews(toArchive,harness.workspace,{environment:harness.executionEnvironment,scope:harness.config.scope});
      const captured=captureApprovalDiffs(state,reviewed,approvedIds);
      const admitted={...state,metadata:{...state.metadata,[APPROVAL_DIFFS_KEY]:JSON.parse(JSON.stringify(captured)),...(!explicitPositive?{[APPROVAL_HISTORY_KEY]:JSON.parse(JSON.stringify([...history,...recorded]))}:{})}};
      readApprovalDecisions(admitted);
      await harness.store.save(admitted,{expectedRevision:state.revision??0});
      state=await getRun(s,c.runId);
      // This command acknowledges a specific reviewed effect, not just a
      // conversational turn. Keep denial/stale-effect failures visible to the
      // client; a later run.start can continue with normal error recovery.
      const authorized = explicitPositive ? issueExplicitReviewResponses(harness,state,approvals,'desktop-host',(options.now??Date.now)(),c.expectedRevision) : issueRecordedApprovalResponses(harness,state,approvals);
      state = (await invoke(s.sessionId, { state, approvals: authorized, toolExecution: { stopOnError: true } })).state;
    }
    s = await sessions.updateRun(s.sessionId, state.runId, { status: sessionStatus(state.status) });
    return { kind: "run", session: sessionDocument(s), run: await documentRun(state) };
  };
  const adapter: HarnessClientAdapter = {
    async dispatchReviewed(value) {
      if (!value || typeof value !== 'object') return { protocolVersion: 1, requestId: null, ok: false, error: { code: 'INVALID_REQUEST' } };
      reviewedRequests.add(value);
      try { return await adapter.dispatch(value); } finally { reviewedRequests.delete(value); }
    },
    async cancelActive() {
      const current = active;
      if (!current) return;
      current.controller.abort();
      // Preparation can be cancelled before the SDK has created a run row.
      if (await harness.store.load(current.runId, harness.config.scope)) {
        await cancelHarnessRun(harness.store, harness.config, current.runId, { cascade: true });
      }
    },
    negotiate(versions) {
      if (closed) return { ok: false, error: { code: "CONNECTION_EXPIRED" } };
      if (!versions.includes(1)) return { ok: false, error: { code: "VERSION_UNSUPPORTED" } };
      return { ok: true, protocolVersion: 1, connectionId, projectId, capabilities: ["project.get", "policy.get", "session.list", "session.create", "session.get", "session.rename", "run.start", "run.get", "approval.resolve", "run.cancel.checkpoint", "run.cancel.active", "idempotency.connection", "revision.precondition", "checkpoint.list", "checkpoint.inspect", "checkpoint.capture", "restore.prepare", "restore.get", "restore.apply", "restore.recoverFork"] };
    },
    async dispatch(value) {
      const hostReviewed = Boolean(value && typeof value === 'object' && reviewedRequests.delete(value));
      const parsed = harnessClientRequestSchema.safeParse(value);
      if (!parsed.success) return { protocolVersion: 1, requestId: null, ok: false, error: { code: "INVALID_REQUEST" } };
      const request = parsed.data;
      const error = (code: HarnessClientErrorCode, cause?: unknown): HarnessClientResponse => {
        const diagnostic = providerStreamDiagnostic(cause);
        return { protocolVersion: 1, requestId: request.requestId, ok: false, error: { code, ...(diagnostic ? { providerDiagnostic: diagnostic } : {}) } };
      };
      if (closed || request.connectionId !== connectionId) return error("CONNECTION_EXPIRED");
      const c = request.command;
      if (hostReviewed && c.method !== 'approval.resolve') return error('INVALID_REQUEST');
      const key = "idempotencyKey" in c ? c.idempotencyKey : undefined;
      const fingerprint = digest({ command: c, hostReviewed });
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
              return { protocolVersion: 1, requestId: request.requestId, ok: true, data: { kind: "run", session: sessionDocument(s), run: await documentRun(latest) } };
            } catch { return error("EXECUTION_FAILED"); }
          })();
          if(key) receipts.set(key, { fingerprint, response: cancellation });
          return structuredClone(await cancellation);
        }
        if (c.projectId === projectId && ["project.get", "policy.get", "session.get", "session.list"].includes(c.method)) {
          try {
            // Reads must not refresh/write session revisions while a run owns mutation admission.
            const data: HarnessClientData = c.method === "project.get" ? {kind:"project",projectId}
              : c.method === "policy.get" ? {kind:"policy",policy:inspectHarnessPolicy(active?.runtime ?? harness)}
              : c.method === "session.get" ? {kind:"session",session:sessionDocument(await getSession(c.sessionId))}
              : {kind:"sessions",sessions:await Promise.all((await sessions.list(c.method === "session.list" && c.search !== undefined ? {search:c.search}:{})).map(async s=>sessionDocument(await getSession(s.sessionId))))};
            return {protocolVersion:1,requestId:request.requestId,ok:true,data};
          } catch { return error("NOT_FOUND"); }
        }
        if (c.method === "run.get" && c.projectId === projectId) {
          try { const s = await getSession(c.sessionId); const state = await getRun(s, c.runId); return { protocolVersion: 1, requestId: request.requestId, ok: true, data: { kind: "run", session: sessionDocument(s), run: c.includeReview ? await attachApprovalPreviews(await documentRun(state,c.decisionOffset,c.includeDiff), harness.workspace,{environment:harness.executionEnvironment,scope:harness.config.scope}) : await documentRun(state,c.decisionOffset,c.includeDiff) } }; }
          catch { return error("NOT_FOUND"); }
        }
        return error(c.method === "approval.resolve" ? "REVISION_CONFLICT" : "BUSY");
      }
      if (key && receipts.size >= 1024) return error("CAPACITY_EXCEEDED");
      busy = true;
      const response = (async (): Promise<HarnessClientResponse> => {
        try { return { protocolVersion: 1, requestId: request.requestId, ok: true, data: await execute(c, hostReviewed) }; }
        catch (e) { return error(e instanceof ClientFault ? e.code : e instanceof HarnessStateConflictError ? "REVISION_CONFLICT" : "EXECUTION_FAILED", e); }
        finally { busy = false; }
      })();
      if (key) receipts.set(key, { fingerprint, response });
      return structuredClone(await response);
    },
    close() { if (closed) return; if (busy) return fail("BUSY"); closed = true; checkpoints?.close(); sessions.close(); receipts.clear(); }
  };
  return adapter;
};
