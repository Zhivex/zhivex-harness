import { writeSync } from "node:fs";
import { benchmarkProgressSchema, benchmarkSpanSchema, benchmarkOperationSchema } from "../src/runtime/error-diagnostics.js";
import type { z } from "zod";

type Progress = z.infer<typeof benchmarkProgressSchema>;
const started = performance.now();
let phaseStarted = started;
let state: Progress = { phase: "startup", lastEvent: "none", elapsedMs: 0, phaseElapsedMs: 0, idleMs: 0, steps: 0, toolCalls: 0, toolResults: 0 };
let lastTextAt = -Infinity;
let sequence = 0;
const spans = new Map<number, z.infer<typeof benchmarkSpanSchema>>();
const history: NonNullable<Progress["history"]> = [];
let budget: Progress["budget"];
const elapsed = () => Math.max(0, Math.round(performance.now() - started));
export function configureBenchmarkBudget(supervisorMs: number, agentMs: number, toolMs: number) {
  budget = { supervisorMs, agentMs, toolMs, remainingMs: supervisorMs, expired: "none" };
}
export function markBenchmarkTimeout(scope: "agent" | "tool") {
  if (budget) budget.expired = scope;
  reportBenchmarkProgress(state.phase);
}
export function beginBenchmarkSpan(operation: z.infer<typeof benchmarkOperationSchema>, parentId?: number, attempt?: number) {
  const id = ++sequence;
  spans.set(id, { id, operation, startedMs: elapsed(), durationMs: 0, outcome: "running", ...(parentId ? { parentId } : {}), ...(attempt ? { attempt } : {}) });
  while (spans.size > 24) {
    const completed = [...spans].find(([, span]) => span.outcome !== "running");
    spans.delete(completed?.[0] ?? spans.keys().next().value!);
  }
  reportBenchmarkProgress(state.phase);
  return id;
}
export function updateBenchmarkSpan(id: number, values: Partial<Pick<z.infer<typeof benchmarkSpanSchema>, "outcome" | "firstTokenMs" | "httpStatus" | "provider" | "failureKind">>) {
  const span = spans.get(id);
  if (!span) return;
  const parsed = benchmarkSpanSchema.safeParse({ ...span, ...values, durationMs: values.outcome ? elapsed() - span.startedMs : span.durationMs });
  if (parsed.success) {
    spans.set(id, parsed.data);
    if (parsed.data.provider || (parsed.data.failureKind && (parsed.data.operation === "http" || (!state.lastProviderFailure?.provider && state.lastProviderFailure?.parentId !== id)))) state = { ...state, lastProviderFailure: parsed.data };
  }
  reportBenchmarkProgress(state.phase);
}
export function benchmarkToolName(name: string) {
  const parsed = benchmarkOperationSchema.safeParse(name);
  return parsed.success && !["generate", "stream", "http"].includes(parsed.data) && !parsed.data.startsWith("oci_") ? parsed.data : "other_tool" as const;
}
export function benchmarkSnapshot(): Progress {
  const now = elapsed();
  return { ...state, elapsedMs: now, phaseElapsedMs: Math.round(performance.now() - phaseStarted), spans: [...spans.values()].map(span => span.outcome === "running" ? { ...span, durationMs: now - span.startedMs } : { ...span }), history: [...history],
    ...(budget ? { budget: { ...budget, remainingMs: Math.max(0, budget.supervisorMs - now) } } : {}) };
}

// Synchronous small writes ensure the supervisor has evidence before a hard kill.
// Never serialize the event, its payload, names, paths, model text or credentials.
export function reportBenchmarkProgress(phase: Progress["phase"], eventType?: string): void {
  if (process.env.ZHIVEX_BENCHMARK_PROGRESS !== "1") return;
  const now = performance.now();
  if (phase !== state.phase) { phaseStarted = now; history.push({ phase, atMs: elapsed() }); if (history.length > 16) history.shift(); }
  const parsed = benchmarkProgressSchema.shape.lastEvent.safeParse(eventType);
  state = { ...state, phase, elapsedMs: Math.round(now - started), phaseElapsedMs: Math.round(now - phaseStarted),
    lastEvent: parsed.success ? parsed.data : phase !== state.phase ? "none" : state.lastEvent,
    steps: state.steps + Number(eventType === "agent-step-start"),
    toolCalls: state.toolCalls + Number(eventType === "tool-call"),
    toolResults: state.toolResults + Number(eventType === "tool-result") };
  if (eventType === "text-delta") {
    if (now - lastTextAt < 1000) return;
    lastTextAt = now;
  }
  try { writeSync(3, `${JSON.stringify(benchmarkSnapshot())}\n`); } catch { /* Observability cannot change run behavior. */ }
}

// Public Node API exposes resource types only, never endpoints or handle contents.
export function reportBenchmarkResources(phase: Progress["phase"]): void {
  const allowed = new Set(["Timeout", "TCPWrap", "TCPSocketWrap", "TLSWrap", "PipeWrap", "PipeConnectWrap", "ProcessWrap", "FSReqCallback", "FSReqPromise", "GetAddrInfoReqWrap", "Immediate"]);
  const counts = new Map<string, number>();
  for (const raw of process.getActiveResourcesInfo()) {
    const type = allowed.has(raw) ? raw : "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const parsed = benchmarkProgressSchema.shape.resources.parse([...counts].map(([type, count]) => ({ type, count })));
  state = { ...state, resourceObservation: process.versions.bun ? "unsupported" : "node", resources: parsed };
  reportBenchmarkProgress(phase);
}
export function startBenchmarkExitObservation(): void {
  reportBenchmarkResources("result_written");
  // This observer must never keep a completed child alive itself.
  const timer = setInterval(() => reportBenchmarkResources("exit_pending"), 1000);
  timer.unref();
  process.once("beforeExit", () => clearInterval(timer));
}
