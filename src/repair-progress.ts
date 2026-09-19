import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ToolSet, ToolExecutionContext } from "@zhivex-ai/core";
import { z } from "zod";

export const REPAIR_PROGRESS_KEY = "zhivexRepairProgress";
const savedProgress = z.object({ closureReads: z.number().int().min(0), closureCommands: z.number().int().min(0),
  enteredClosure: z.boolean(), plannedPaths: z.array(z.string().max(240)).max(8),
  seen: z.array(z.tuple([z.string().max(128), z.object({ output: z.string().length(64), count: z.number().int().min(1) })])).max(128),
  lines: z.array(z.tuple([z.string().length(64), z.number().int().min(1)])).max(256).default([]) });

const observations = new Set(["inspect_environment_patch", "mutation_audit", "git_diff", "read_task", "environment_status", "load_skill", "propose_edits"]);
const reads = new Set(["list_files", "read_file", "read_files", "search_files", "search_many"]);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** One controller per run. Stores only bounded hashes, never source or arguments.
 * Changes execution strategy, not permission/approval policy or token ceilings. */
export const createRepairProgress = (usage: () => { inputTokens: number; outputTokens: number },
  limits: { inputTokens: number; outputTokens: number }, metadata?: Record<string, unknown>) => {
  const restored = metadata?.[REPAIR_PROGRESS_KEY] === undefined ? undefined : savedProgress.parse(metadata[REPAIR_PROGRESS_KEY]);
  let closureReads = restored?.closureReads ?? 0, closureCommands = restored?.closureCommands ?? 0;
  let plannedPaths: string[] = restored?.plannedPaths ?? [];
  let outputStep = -1, outputCharacters = 0;
  const seen = new Map<string, { output: string; count: number }>(restored?.seen);
  const linesSeen = new Map<string, number>(restored?.lines);
  const stats = { repeatedResults: 0, suppressedResults: 0, blockedBroadCalls: 0, enteredClosure: restored?.enteredClosure ?? false, phase: plannedPaths.length ? "repair" : "explore", blockedPhaseCalls: 0, planRecorded: !!plannedPaths.length };
  const snapshot = () => ({ closureReads, closureCommands, enteredClosure: stats.enteredClosure, plannedPaths: [...plannedPaths], seen: [...seen], lines: [...linesSeen] });
  const closing = () => {
    const used = usage();
    stats.enteredClosure ||= used.inputTokens >= limits.inputTokens * 0.7 || used.outputTokens >= limits.outputTokens * 0.7;
    return stats.enteredClosure;
  };
  const wrapTools = (tools: ToolSet): ToolSet => Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (!("execute" in definition)) return [name, definition];
    return [name, { ...definition, async execute(input: unknown, context: ToolExecutionContext) {
      try {
      if (name === "repair_plan") {
        const plan = input as { paths?: string[] };
        plannedPaths = plan.paths ?? []; stats.planRecorded = true; stats.phase = "explore";
        return definition.execute(input, context);
      }
      if (observations.has(name)) return definition.execute(input, context);
      if (name.startsWith("verify_")) stats.phase = "verify";
      if (!reads.has(name)) {
        if (closing() && name.startsWith("run_environment") && ++closureCommands > 3) {
          stats.blockedPhaseCalls++;
          throw new Error("REPAIR_PHASE_BUDGET: the closure command allowance is exhausted. Use an inspected patch and the approved verifier, or report the incomplete repair.");
        }
        // Commands and failed mutations may change files. Never deduplicate effects.
        seen.clear();
        linesSeen.clear();
        return definition.execute(input, context);
      }
      const requestedPath = input && typeof input === "object" ? (input as Record<string, unknown>).path : undefined;
      const pathInput = input && typeof input === "object" ? input as { files?: { path?: unknown }[] } : {};
      const requestedPaths = name === "read_files" && Array.isArray(pathInput.files)
        ? pathInput.files.map(file => file.path) : [requestedPath];
      const normalizedPaths = requestedPaths.filter((value): value is string => typeof value === "string")
        .map(value => posix.normalize(value));
      const normalizedPlan = plannedPaths.map(value => posix.normalize(value));
      const globalSearch = requestedPath === undefined || (typeof requestedPath === "string" && posix.normalize(requestedPath || ".") === ".");
      if (closing() && (name === "list_files" ||
        (["search_files", "search_many"].includes(name) && globalSearch))) {
        stats.blockedBroadCalls++;
        throw new Error("REPAIR_CLOSURE: broad discovery is paused to preserve the remaining budget. Use known file paths for focused reads/searches, reproduce the issue, repair and verify. If context is insufficient, report the limitation; do not guess a patch.");
      }
      if (closing() && ++closureReads > 4) {
        stats.blockedPhaseCalls++;
        throw new Error("REPAIR_PHASE_BUDGET: the closure read allowance is exhausted. Recover task constraints with read_task, repair known files, and verify or report the limitation.");
      }
      if (closing() && plannedPaths.length && normalizedPaths.some(value => !normalizedPlan.includes(value))) {
        stats.blockedPhaseCalls++;
        throw new Error("REPAIR_PLAN_SCOPE: use a file recorded in repair_plan or explicitly revise the hypothesis first.");
      }
      const output = await definition.execute(input, context);
      if (outputStep !== context.step) { outputStep = context.step; outputCharacters = 0; }
      outputCharacters += JSON.stringify(output).length;
      if (outputCharacters > 32_000) throw new Error("TOOL_OUTPUT_BUDGET: this turn's read output is full. Request a narrower slice on a new turn.");
      // Search requests with different wording but identical evidence are still
      // repetition. Keep hashes only; every read still checks current bytes.
      const data = output && typeof output === "object" ? output as Record<string, any> : {};
      const evidence = Array.isArray(data.matches) && data.matches.length ? data.matches :
        Array.isArray(data.results) ? data.results.flatMap((r: any) => r.matches ?? []) : undefined;
      const key = evidence?.length ? hash({ evidence }) : hash({ name, input });
      const fingerprint = hash(evidence?.length ? evidence : output);
      const prior = seen.get(key);
      const count = prior?.output === fingerprint ? prior.count + 1 : 1;
      seen.delete(key);
      seen.set(key, { output: fingerprint, count });
      if (seen.size > 128) seen.delete(seen.keys().next().value!);
      if (count > 1) stats.repeatedResults++;
      const files = Array.isArray(data.files) ? data.files : [data];
      const lineKeys: string[] = files.flatMap((file: any) => typeof file.path === "string" &&
        typeof file.digest === "string" && typeof file.content === "string" ? file.content.split("\n").map((line: string) => hash({ path: file.path, digest: file.digest, line })) : []);
      const overlapping = lineKeys.length > 0 && lineKeys.length <= 256 && lineKeys.every(key => (linesSeen.get(key) ?? 0) >= 2);
      for (const key of new Set(lineKeys.slice(0, 256))) {
        const count = (linesSeen.get(key) ?? 0) + 1; linesSeen.delete(key); linesSeen.set(key, count);
        if (linesSeen.size > 256) linesSeen.delete(linesSeen.keys().next().value!);
      }
      if (count > 2 || overlapping) {
        stats.suppressedResults++;
        throw new Error("REPEATED_EXPLORATION: this request returned unchanged or fully overlapping evidence at least three times. Its repeated payload was omitted. Request new evidence or proceed to reproduction and verification. No cached source was substituted.");
      }
      return output;
      } finally {
        if (context.metadata) context.metadata[REPAIR_PROGRESS_KEY] = snapshot();
      }
    } }];
  }));
  return { stats, closing, wrapTools, snapshot };
};
