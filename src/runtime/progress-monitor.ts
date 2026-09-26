import { createHash } from "node:crypto";
import type { ToolSet } from "@zhivex-ai/core";
import { z } from "zod";

export const PROGRESS_MONITOR_KEY = "zhivexProgressMonitor";
const HISTORY_LIMIT = 64;
const MAX_CYCLE = 8;
const EXPLORATION_LIMIT = 8;
const explorationTools = new Set(["read_file", "read_files", "read_dependency", "list_files", "search_files", "search_many"]);
const editingTools = new Set(["apply_patch", "apply_reviewed_replacement", "apply_reviewed_edits",
  "move_file", "quarantine_file", "restore_file", "apply_environment_patch",
  "verify_and_apply_environment_patch", "verify_and_apply_reviewed_edits"]);
const stateSchema = z.object({
  version: z.literal(1),
  exploration: z.number().int().min(0).max(EXPLORATION_LIMIT).optional(),
  history: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(HISTORY_LIMIT),
});
export type ProgressMonitorState = z.infer<typeof stateSchema>;
export type ProgressSignal = {
  action: "continue" | "recover" | "stop";
  repetitions: number;
  cycleLength: number;
};

// Tool payloads are JSON-shaped. Key ordering must not disguise a repeated action.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Advisory, profile-independent monitor. Observe completed operations; enforce a stop only
 * before the next model request. Never throw away results or suppress already executed effects.
 * An explicit revision can distinguish operations whose identical output hides real progress.
 * State contains bounded hashes and a capped counter, surviving compaction/resume through run metadata. */
export const createProgressMonitor = (metadata?: Record<string, unknown>) => {
  const restored = metadata?.[PROGRESS_MONITOR_KEY];
  const initial = restored === undefined ? undefined : stateSchema.parse(restored);
  let history = initial ? [...initial.history] : [];
  let exploration = initial?.exploration ?? 0;
  const snapshot = (): ProgressMonitorState & { exploration: number } => ({ version: 1, history: [...history], exploration });
  const persist = (target = metadata) => { if (target) target[PROGRESS_MONITOR_KEY] = snapshot(); };
  const observe = (value: unknown) => {
    // Observation is best-effort for non-JSON custom outputs; it must never
    // replace a successfully executed operation with a serialization error.
    try { history.push(digest(value)); } catch { history = []; }
    if (history.length > HISTORY_LIMIT) history.shift();
    persist();
  };
  const check = (): ProgressSignal => {
    let best: ProgressSignal = { action: "continue", repetitions: 0, cycleLength: 0 };
    for (let length = 1; length <= MAX_CYCLE && length * 3 <= history.length; length++) {
      let repetitions = 1;
      const end = history.length;
      while ((repetitions + 1) * length <= end &&
        history.slice(end - length, end).every((hash, index) =>
          hash === history[end - (repetitions + 1) * length + index])) repetitions++;
      if (repetitions >= 3 && repetitions > best.repetitions) {
        best = { action: repetitions >= 5 ? "stop" : "recover", repetitions, cycleLength: length };
      }
    }
    return best;
  };
  const observeTool = (name: string, input: unknown, output: unknown, options?: { failed?: boolean; revision?: string }) => {
    // Varied exploration can stall without an exact cycle. Count attempts, including
    // failures; only a successful edit/check resets this separate advisory.
    if (explorationTools.has(name)) exploration = Math.min(EXPLORATION_LIMIT, exploration + 1);
    const result = output && typeof output === "object" ? output as Record<string, unknown> : undefined;
    const succeeded = !options?.failed && result?.success !== false && result?.ok !== false &&
      !result?.error && result?.isError !== true;
    if (succeeded && (editingTools.has(name) ||
      (name === "run_check" && result?.exitCode === 0 && !result?.timedOut))) exploration = 0;
    observe({ kind: "tool", name, input, output, failed: options?.failed ?? false, revision: options?.revision });
  };
  const observeText = (text: string) => {
    const normalized = text.trim().replace(/\s+/g, " ");
    // Short acknowledgements are common and do not establish a stalled reasoning loop.
    if (normalized.length >= 80) observe({ kind: "text", text: normalized });
  };
  const markProgress = () => { history = []; exploration = 0; persist(); };
  const needsExplorationDecision = () => exploration >= EXPLORATION_LIMIT;
  const wrapTools = (tools: ToolSet): ToolSet => Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (!("execute" in definition)) return [name, definition];
    return [name, { ...definition, async execute(input, context) {
      try {
        const result = await definition.execute(input, context);
        observeTool(name, input, result);
        return result;
      } catch (error) {
        observeTool(name, input, error instanceof Error ? { name: error.name, message: error.message } : String(error), { failed: true });
        throw error;
      } finally {
        persist(context?.metadata);
      }
    } } satisfies typeof definition];
  }));
  return { observeTool, observeText, markProgress, check, snapshot, wrapTools, needsExplorationDecision };
};
