import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeAgentRunState, serializeJsonValue, wrapLanguageModel } from "@zhivex-ai/core";
import { runAgentGroup, type AgentRunState, type AgentRunOutput, type AgentDefinition, type LanguageModel } from "@zhivex-ai/agents";
import type { AgentRunStore } from "@zhivex-ai/agents/ops";
import type { UsageLedger } from "./usage-ledger.js";
import type { HarnessConfig, HarnessSubagentProfile } from "./config.js";
import { HarnessConfigError, HarnessStateConflictError } from "./errors.js";

const KEY = "harnessReviewGroupV1";
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  cancellationRequested: z.boolean(),
  members: z.array(z.strictObject({ profile: z.enum(["explorer", "reviewer"]), runId: z.string(), idempotencyKey: z.string(), admitted: z.boolean(), blocked: z.boolean() })).min(1).max(2)
});
type Record = z.infer<typeof recordSchema>;
type Runtime = { usageLedger?: UsageLedger; config: HarnessConfig; store: AgentRunStore; subagents: ReadonlyMap<HarnessSubagentProfile, AgentDefinition<LanguageModel>> };
const terminal = (state: AgentRunState) => ["completed", "failed", "cancelled", "timed_out"].includes(state.status);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readRecord = (state: AgentRunState): Record => {
  const value = recordSchema.safeParse(state.metadata?.[KEY]);
  if (!value.success || state.agentId !== "zhivex-harness-review-group") throw new HarnessStateConflictError("Not a durable Harness review group.");
  // Existing run-cancellation operations also close this group's admission.
  // Their generic tree/terminal semantics remain owned by the SDK.
  if (state.status === "cancel_requested" || state.status === "cancelled") value.data.cancellationRequested = true;
  return value.data;
};
const requireStore = (store: AgentRunStore) => {
  if (!store.claimIdempotencyKey || !store.acquireLease || !store.renewLease || !store.releaseLease) {
    throw new HarnessConfigError("Durable review groups require atomic idempotency claims, CAS saves and fenced leases.");
  }
};
const rootState = (runtime: Runtime, groupId: string, record: Record): AgentRunState => normalizeAgentRunState({
  schemaVersion: 1, revision: 0, runId: groupId, scope: runtime.config.scope,
  idempotencyKey: `harness-review-group:${groupId}`, agentId: "zhivex-harness-review-group",
  provider: "zhivex", modelId: "review-group", status: "queued", currentStep: 0, maxSteps: 1,
  messages: [], steps: [], toolResults: [], outputText: "", pendingApprovals: [],
  startedAt: Date.now(), updatedAt: Date.now(), metadata: { [KEY]: serializeJsonValue(record) }
});

/** Short, fenced critical section shared by cancellation and fresh child admission. */
async function locked<T>(runtime: Runtime, groupId: string, operation: (root: AgentRunState, owner: string) => Promise<T>): Promise<T> {
  const owner = `review-group:${randomUUID()}`;
  const lease = await runtime.store.acquireLease!(groupId, { ownerId: owner, ttlMs: 30_000 }, runtime.config.scope);
  if (!lease) throw new HarnessStateConflictError("Review group admission is busy; retry with the same groupId.", { retryable: true });
  try {
    const root = await runtime.store.load(groupId, runtime.config.scope);
    if (!root) throw new HarnessStateConflictError("Durable review group was not found.");
    readRecord(root);
    return await operation(root, owner);
  } finally { await runtime.store.releaseLease!(groupId, owner, runtime.config.scope); }
}

function output(state: AgentRunState): AgentRunOutput {
  return { status: state.status, outputText: state.outputText,
    ...(state.finalOutput !== undefined ? { finalOutput: state.finalOutput } : {}),
    ...(state.finishReason ? { finishReason: state.finishReason } : {}),
    ...(state.providerFinishReason ? { providerFinishReason: state.providerFinishReason } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    messages: state.messages, steps: state.steps, toolResults: state.toolResults, state,
    ...(state.error ? { error: state.error } : {}), ...(state.taskOutcome ? { taskOutcome: state.taskOutcome } : {}) };
}
export interface HarnessDurableReviewGroupResult {
  schemaVersion: 1;
  kind: "durable-review-group";
  groupId: string;
  cancellationRequested: boolean;
  status: "queued" | "running" | "blocked" | "waiting_approval" | "suspended" | "completed" | "partial" | "failed" | "timed_out" | "cancel_requested" | "cancelled";
  members: { profile: "explorer" | "reviewer"; runId: string; output?: AgentRunOutput }[];
}

/** Read-only reconstruction; no model calls and no new child identities. */
export async function inspectHarnessReviewGroup(runtime: Runtime, groupId: string): Promise<HarnessDurableReviewGroupResult> {
  const root = await runtime.store.load(groupId, runtime.config.scope);
  if (!root) throw new HarnessStateConflictError("Durable review group was not found.");
  const record = readRecord(root);
  const members = await Promise.all(record.members.map(async member => {
    const state = await runtime.store.load(member.runId, runtime.config.scope);
    if (state && (state.parentRunId !== groupId || state.idempotencyKey !== member.idempotencyKey)) {
      throw new HarnessStateConflictError("Durable review child identity does not match its group.");
    }
    return { profile: member.profile, runId: member.runId, ...(state ? { output: output(state) } : {}) };
  }));
  const states = members.flatMap(m => m.output ? [m.output.state] : []);
  const allDone = states.length === members.length && states.every(terminal);
  const confirmedCancellation = record.cancellationRequested && states.every(terminal) && record.members.every((m, i) => !m.admitted || members[i]?.output !== undefined);
  const status: HarnessDurableReviewGroupResult["status"] = confirmedCancellation ? "cancelled"
    : record.cancellationRequested ? "cancel_requested"
    : allDone ? states.every(s => s.status === "completed") ? "completed"
      : states.some(s => s.status === "completed") ? "partial"
      : states.some(s => s.status === "failed") ? "failed"
      : states.some(s => s.status === "timed_out") ? "timed_out" : "cancelled"
    : states.some(s => s.status === "waiting_approval") ? "waiting_approval"
    : states.some(s => s.status === "suspended") ? "suspended"
    : states.every(terminal) && record.members.some((m, i) => m.blocked && !members[i]?.output) ? "blocked"
    : states.length ? "running" : "queued";
  return { schemaVersion: 1, kind: "durable-review-group", groupId, cancellationRequested: record.cancellationRequested, status, members };
}

/** Opt-in durable counterpart to the legacy, ephemeral runHarnessReviewGroup. */
export async function runHarnessDurableReviewGroup(runtime: Runtime, input: { groupId: string; prompt: string; abortSignal?: AbortSignal },
  profiles: readonly HarnessSubagentProfile[] = ["explorer", "reviewer"]): Promise<HarnessDurableReviewGroupResult> {
  requireStore(runtime.store);
  if (!input.groupId || input.groupId.length > 200 || !input.prompt) throw new HarnessConfigError("A durable group requires a bounded groupId and a prompt.");
  const unique = [...new Set(profiles)];
  if (!unique.length || unique.length > runtime.config.orchestration.maxParallelReviews || unique.some(p => p !== "explorer" && p !== "reviewer")) {
    throw new HarnessConfigError("Durable review groups require enabled read-only explorer/reviewer profiles within maxParallelReviews.");
  }
  const agents = unique.map(profile => {
    const agent = runtime.subagents.get(profile);
    if (!agent) throw new HarnessConfigError(`Subagent profile ${profile} is not enabled.`);
    if (agent.store !== runtime.store) throw new HarnessConfigError("Durable review members must share the Harness run store.");
    return agent;
  });
  const record: Record = { schemaVersion: 1, cancellationRequested: false,
    fingerprint: `sha256:${digest({ prompt: input.prompt, scope: runtime.config.scope, profiles: unique,
      bindings: agents.map(a => ({ id: a.id, harness: a.harness, provider: a.model.provider, model: a.model.modelId })) })}`,
    members: unique.map(profile => ({ profile: profile as "explorer" | "reviewer",
      runId: `review_child_${digest([input.groupId, profile])}`,
      idempotencyKey: `harness-review-member:${digest([input.groupId, profile])}`, admitted: false, blocked: false })) };
  const candidate = rootState(runtime, input.groupId, record);
  const claim = await runtime.store.claimIdempotencyKey!({ ...candidate, idempotencyKey: candidate.idempotencyKey! });
  if (claim.state.runId !== input.groupId || readRecord(claim.state).fingerprint !== record.fingerprint) {
    throw new HarnessStateConflictError("Review group identity is already bound to a different request or runtime.");
  }
  const before = await inspectHarnessReviewGroup(runtime, input.groupId);
  if (before.cancellationRequested || ["completed", "partial", "failed", "timed_out", "cancelled"].includes(before.status)) return before;
  // The SDK fences each running child. Concurrent group callers may receive a
  // busy admission error; retrying preserves member IDs and terminal receipts.
  const members = record.members.map((member, index) => {
    const store = new Proxy(runtime.store, { get(target, key) {
      if (key === "claimIdempotencyKey") return async (state: AgentRunState & { idempotencyKey: string }) => locked(runtime, input.groupId, async (root, owner) => {
        const live = readRecord(root);
        if (live.cancellationRequested) throw new HarnessStateConflictError("Review group admission is closed by cancellation.");
        const entry = live.members.find(m => m.runId === state.runId && m.idempotencyKey === state.idempotencyKey);
        if (!entry || state.parentRunId !== input.groupId) throw new HarnessStateConflictError("Unexpected review member admission.");
        entry.admitted = true;
        entry.blocked = false;
        const revision = root.revision ?? 0;
        await target.save({ ...root, revision: revision + 1, updatedAt: Date.now(),
          metadata: { ...root.metadata, [KEY]: serializeJsonValue(live) } }, { expectedRevision: revision, leaseOwnerId: owner });
        return target.claimIdempotencyKey!(state);
      });
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const admit = () => locked(runtime, input.groupId, async root => {
      if (leaseLost) throw new HarnessStateConflictError("Review group worker lease was lost.");
      if (readRecord(root).cancellationRequested) throw new DOMException("Review group cancelled before request admission.", "AbortError");
    });
    const model = wrapLanguageModel(agents[index]!.model, [{ name: "durable-review-admission-v1",
      async wrapGenerate(_context, next) { await admit(); return next(); },
      async wrapStream(_context, next) { await admit(); return next(); }
    }]);
    const saved = before.members[index]?.output?.state;
    return { name: member.profile, agent: { ...agents[index]!, store, model }, input: {
      ...(saved ? { runId: member.runId } : { runId: member.runId, prompt: input.prompt }),
      idempotencyKey: member.idempotencyKey
    } };
  });
  const workerId = `review_worker_${digest(input.groupId)}`;
  const worker = { ...rootState(runtime, workerId, record), agentId: "zhivex-harness-review-worker", idempotencyKey: `harness-review-worker:${input.groupId}` };
  await runtime.store.claimIdempotencyKey!(worker);
  const ownerId = `review-worker:${randomUUID()}`;
  if (!await runtime.store.acquireLease!(workerId, { ownerId, ttlMs: 30_000 }, runtime.config.scope)) {
    throw new HarnessStateConflictError("Review group is already executing; inspect or retry the same groupId.", { retryable: true });
  }
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void Promise.resolve(runtime.store.renewLease?.(workerId, { ownerId, ttlMs: 30_000 }, runtime.config.scope))
      .then(lease => { if (!lease) leaseLost = true; }, () => { leaseLost = true; });
  }, 10_000);
  heartbeat.unref();
  const cancel = () => { cancellation = cancelHarnessReviewGroup(runtime, input.groupId); void cancellation.catch(() => undefined); };
  let cancellation: Promise<HarnessDurableReviewGroupResult> | undefined;
  input.abortSignal?.addEventListener("abort", cancel, { once: true });
  try {
    if (input.abortSignal?.aborted) cancel();
    let memberResults: Awaited<ReturnType<typeof runAgentGroup>> | undefined;
    if (cancellation) await cancellation;
    else {
      const operation = () => runAgentGroup(members, { parentRunId: input.groupId, scope: runtime.config.scope,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}), stopOnError: false, maxConcurrency: 1 });
      memberResults = await (runtime.usageLedger ? runtime.usageLedger.run(input.groupId, operation) : operation());
    }
    if (cancellation) await cancellation;
    return await locked(runtime, input.groupId, async (root, owner) => {
      const live = readRecord(root);
      for (const [index, member] of live.members.entries()) member.blocked = memberResults?.outputs[index]?.status === "rejected";
      root.metadata = { ...root.metadata, [KEY]: serializeJsonValue(live) };
      // Persist rejection markers before reconstructing the public snapshot.
      let revision = root.revision ?? 0;
      await runtime.store.save({ ...root, revision: revision + 1, updatedAt: Date.now() }, { expectedRevision: revision, leaseOwnerId: owner });
      root.revision = ++revision;
      const result = await inspectHarnessReviewGroup(runtime, input.groupId);
      await runtime.store.save({ ...root, revision: revision + 1, updatedAt: Date.now(),
        status: result.status === "partial" ? "failed" : result.status === "blocked" ? "suspended" : result.status,
        childRuns: result.members.flatMap(member => member.output ? [{
          runId: member.runId, parentRunId: input.groupId, ...(member.output.state.agentId ? { agentId: member.output.state.agentId } : {}),
          status: member.output.status, outputText: member.output.outputText,
          steps: member.output.steps.length, toolCalls: member.output.toolResults.length,
          toolErrors: member.output.toolResults.filter(t => t.isError).length,
          ...(member.output.usage ? { usage: member.output.usage } : {})
        }] : []),
        metadata: { ...root.metadata, harnessReviewGroupStatusV1: result.status } },
        { expectedRevision: revision, leaseOwnerId: owner });
      return result;
    });
  } finally {
    input.abortSignal?.removeEventListener("abort", cancel);
    clearInterval(heartbeat);
    await runtime.store.releaseLease!(workerId, ownerId, runtime.config.scope);
  }
}

/** Persist intention before traversal. Never change a terminal child. */
export async function cancelHarnessReviewGroup(runtime: Runtime, groupId: string): Promise<HarnessDurableReviewGroupResult> {
  requireStore(runtime.store);
  const record = await locked(runtime, groupId, async (root, owner) => {
    const record = readRecord(root);
    const snapshot = await inspectHarnessReviewGroup(runtime, groupId);
    if (["completed", "partial", "failed", "timed_out", "cancelled"].includes(snapshot.status)) return record;
    record.cancellationRequested = true;
    const revision = root.revision ?? 0;
    await runtime.store.save({ ...root, revision: revision + 1, status: "cancel_requested",
      updatedAt: Date.now(), metadata: { ...root.metadata, [KEY]: serializeJsonValue(record) } },
      { expectedRevision: revision, leaseOwnerId: owner });
    return record;
  });
  if (record.cancellationRequested) for (const member of record.members) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const child = await runtime.store.load(member.runId, runtime.config.scope);
      if (!child || terminal(child) || child.status === "cancel_requested") break;
      // CAS conflicts reload and recheck terminal status instead of replaying a
      // stale cancellation write over a completed receipt.
      try {
        await runtime.store.save({ ...child, revision: (child.revision ?? 0) + 1,
          status: ["waiting_approval", "suspended", "queued"].includes(child.status) ? "cancelled" : "cancel_requested",
          cancelledAt: Date.now(), updatedAt: Date.now() }, { expectedRevision: child.revision ?? 0 });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConflictError" || attempt === 7) throw error;
      }
    }
  }
  return inspectHarnessReviewGroup(runtime, groupId);
}
