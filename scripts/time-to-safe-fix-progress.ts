import { writeSync } from "node:fs";
import { benchmarkProgressSchema } from "../src/runtime/error-diagnostics.js";
import type { z } from "zod";

type Progress = z.infer<typeof benchmarkProgressSchema>;
const started = performance.now();
let phaseStarted = started;
let state: Progress = { phase: "startup", lastEvent: "none", elapsedMs: 0, phaseElapsedMs: 0, idleMs: 0, steps: 0, toolCalls: 0, toolResults: 0 };
let lastTextAt = -Infinity;

// Synchronous small writes ensure the supervisor has evidence before a hard kill.
// Never serialize the event, its payload, names, paths, model text or credentials.
export function reportBenchmarkProgress(phase: Progress["phase"], eventType?: string): void {
  if (process.env.ZHIVEX_BENCHMARK_PROGRESS !== "1") return;
  const now = performance.now();
  if (phase !== state.phase) phaseStarted = now;
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
  try { writeSync(3, `${JSON.stringify(state)}\n`); } catch { /* Observability cannot change run behavior. */ }
}
