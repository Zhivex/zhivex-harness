import { LOCAL_TOOL_NAMES } from "../tools/tool-registry.js";
import { captureTaskSources } from "./task-memory.js";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import type { ModelMessage } from "@zhivex-ai/core";

export const COMPACTION_STRATEGY = "bounded-evidence-v5";
const PREFIX = "[Compacted conversation context]\n";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const LOCAL_TOOLS = LOCAL_TOOL_NAMES;

/** Lossy recollection, never an approval or an authoritative verification receipt. */
export const summarizeHarnessMessages = (messages: readonly ModelMessage[], maxCharacters = 4_000) => {
  const redaction = createRedactionPolicy({ includeEmails: true });
  const clean = (text: string, limit = 512) => redaction.redactText(text)
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|password)\s*([=:])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]")
    .replace(/\b(?:sk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, limit);
  let objective = "";
  const recent: string[] = [];
  const steering: string[] = [];
  const evidence: string[] = [];
  const checks: string[] = [];
  let workingPlan: { hypothesis: string; expectedBehavior: string; nextCheck: string; paths: string[] } | undefined;
  const locations: { kind: "read" | "search"; path: string; digest: string; startLine: number; endLine: number; clippedLine?: boolean }[] = [];
  let omitted = false;
  const add = (items: string[], value: string, maximum: number) => {
    items.push(value);
    if (items.length > maximum) { items.shift(); omitted = true; }
  };
  const safePath = (value: unknown) => typeof value === "string" && value.length <= 240 &&
    !value.startsWith("/") && !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || /^(?:\.env(?:\.|$)|\.npmrc$|id_rsa$|id_ed25519$)|\.(?:key|pem|p12|pfx)$/i.test(part))
    ? clean(value, 240) : undefined;
  const addLocation = (value: unknown, kind?: "read" | "search") => {
    const item = record(value);
    const locationKind = kind ?? item.kind;
    const filePath = safePath(item.path);
    const startLine = locationKind === "search" && kind ? item.line : item.startLine;
    const endLine = locationKind === "search" && kind ? item.line : item.endLine;
    if ((locationKind !== "read" && locationKind !== "search") || !filePath ||
      typeof item.path !== "string" || /[\x00-\x1f\x7f]/.test(item.path) ||
      typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.digest) ||
      !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      (startLine as number) < 1 || (endLine as number) < (startLine as number)) return;
    const location: (typeof locations)[number] = { kind: locationKind, path: filePath, digest: item.digest,
      startLine: startLine as number, endLine: endLine as number,
      ...(locationKind === "read" && typeof item.clippedLine === "boolean" ? { clippedLine: item.clippedLine } : {}) };
    // A newly observed digest invalidates every older location for that file.
    // Identical observations move to the end instead of consuming more context.
    for (let i = locations.length - 1; i >= 0; i--) {
      const previous = locations[i]!;
      if (previous.path === location.path && (previous.digest !== location.digest ||
        (previous.kind === location.kind && previous.startLine === location.startLine && previous.endLine === location.endLine))) {
        locations.splice(i, 1);
      }
    }
    locations.push(location);
    if (locations.length > 8) { locations.shift(); omitted = true; }
  };
  const rememberPlan = (value: unknown) => {
    const plan = record(value);
    if (typeof plan.hypothesis !== "string" || typeof plan.expectedBehavior !== "string" || typeof plan.nextCheck !== "string") return;
    workingPlan = { hypothesis: clean(plan.hypothesis, 512), expectedBehavior: clean(plan.expectedBehavior, 512),
      nextCheck: clean(plan.nextCheck, 256), paths: Array.isArray(plan.paths)
        ? plan.paths.slice(0, 8).map(safePath).filter((p): p is string => p !== undefined) : [] };
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    for (const part of message.parts) {
      if (part.type === "text") {
        // Carry our bounded recollection across interactive compactions. Revalidate
        // and redact it: a matching user-supplied marker confers no authority.
        const summaryPrefix = [PREFIX, "[Compacted prior conversation]\n"].find((prefix) => part.text.startsWith(prefix));
        if (summaryPrefix) {
          try {
            const previous = record(JSON.parse(part.text.slice(summaryPrefix.length)));
            if ([COMPACTION_STRATEGY, "bounded-evidence-v4", "bounded-evidence-v3", "bounded-evidence-v2", "bounded-evidence-v1"].includes(String(previous.strategy))) {
              if (!objective && typeof previous.objective === "string") objective = clean(previous.objective, 768);
              for (const [key, target, count] of [["steering", steering, 3], ["recent", recent, 4], ["evidence", evidence, 12], ["checks", checks, 4]] as const) {
                if (Array.isArray(previous[key])) for (const value of previous[key].slice(-count)) {
                  if (typeof value === "string") add(target, clean(value), count);
                }
              }
              if (Array.isArray(previous.locations)) {
                for (const location of previous.locations.slice(-8)) addLocation(location);
              }
              omitted ||= previous.omitted === true;
              rememberPlan(previous.workingPlan);
              continue;
            }
          } catch { /* Treat malformed recollections as ordinary untrusted text. */ }
        }
        const text = clean(part.text, message.role === "user" && !objective ? 768 : 512);
        omitted ||= text.length < part.text.length;
        if (message.role === "user" && !objective) objective = text;
        else if (message.role === "user") add(steering, text, 3);
        else add(recent, `${message.role}: ${text}`, 4);
      } else if (part.type === "tool-call") {
        const call = part.toolCall;
        const name = LOCAL_TOOLS.has(call.name) ? call.name : "external-tool";
        const input = record(call.input);
        const paths = LOCAL_TOOLS.has(call.name)
          ? [input.path, ...(Array.isArray(input.files) ? input.files.slice(0, 20).map((file) => record(file).path) : []),
            ...(Array.isArray(input.changes) ? input.changes.slice(0, 20).map((change) => record(change).path) : [])]
            .map(safePath).filter((value): value is string => value !== undefined)
          : [];
        add(evidence, clean(`tool-call:${name}${paths.length ? ` paths=${JSON.stringify([...new Set(paths)])}` : ""}`), 12);
      } else if (part.type === "tool-result") {
        const result = part.toolResult;
        const name = LOCAL_TOOLS.has(result.toolName) ? result.toolName : "external-tool";
        const output = LOCAL_TOOLS.has(result.toolName) ? record(result.output) : {};
        if (!result.isError) {
          if (name === "read_file") addLocation(output, "read");
          if (name === "read_files" && Array.isArray(output.files)) {
            for (const file of output.files.slice(0, 20)) addLocation(file, "read");
          }
          if (name === "search_files" && Array.isArray(output.matches)) {
            for (const match of output.matches.slice(0, 8)) addLocation(match, "search");
          }
          if (name === "search_many" && Array.isArray(output.results)) {
            for (const group of output.results.slice(0, 20)) {
              const matches = record(group).matches;
              if (Array.isArray(matches)) for (const match of matches.slice(0, 8)) addLocation(match, "search");
            }
          }
        }
        const fields: Record<string, unknown> = {};
        if (typeof result.isError === "boolean") fields.isError = result.isError;
        // Only allow typed facts. Raw logs, errors, source and MCP payloads are excluded.
        for (const [key, value] of Object.entries({ exitCode: output.exitCode, timedOut: output.timedOut,
          verificationExitCode: record(output.verification).exitCode })) {
          if (key === "timedOut" ? typeof value === "boolean" : Number.isSafeInteger(value)) fields[key] = value;
        }
        for (const key of ["digest", "patchId"] as const) {
          if (typeof output[key] === "string" && /^sha256:[a-f0-9]{64}$/.test(output[key])) fields[key] = output[key];
        }
        const filePath = safePath(output.path);
        if (filePath) fields.path = filePath;
        if (name === "repair_plan" && !result.isError) {
          rememberPlan(output);
        }
        const entry = `tool-result:${name} ${JSON.stringify(fields)}`;
        if (fields.exitCode !== undefined || fields.verificationExitCode !== undefined || fields.isError === true) add(checks, entry, 4);
        else add(evidence, entry, 12);
      }
    }
  }
  const state = { strategy: COMPACTION_STRATEGY, objective, steering, recent, checks, evidence, locations,
    ...(workingPlan ? { workingPlan } : {}), omitted };
  const encode = () => JSON.stringify(state);
  while (encode().length > maxCharacters && (recent.length || evidence.length || checks.length || steering.length || locations.length)) {
    state.omitted = true;
    if (evidence.length) evidence.shift();
    else if (recent.length > 1) recent.shift();
    else if (locations.length > 1) locations.shift();
    else if (checks.length > 1) checks.shift();
    else if (recent.length) recent.shift();
    else if (checks.length) checks.shift();
    else if (locations.length) locations.shift();
    else if (state.workingPlan) delete state.workingPlan;
    else steering.shift();
  }
  if (encode().length > maxCharacters && state.workingPlan) {
    state.omitted = true;
    delete state.workingPlan;
  }
  while (encode().length > maxCharacters && state.objective.length) {
    state.omitted = true;
    state.objective = state.objective.slice(0, Math.max(0, state.objective.length - 64));
  }
  // Runtime budgets are at least 128 characters; this fallback also bounds tiny callers.
  const summary = encode().length <= maxCharacters ? encode() : "{}".slice(0, maxCharacters);
  return { summary, truncated: state.omitted };
};

// Preserve source requests out of band for direct callers; CLI persists these in
// run metadata before compaction. They never become an unbounded provider prompt.
const sourceRequests = new WeakMap<readonly ModelMessage[], ReturnType<typeof captureTaskSources>>();
export const compactedTaskSources = (messages: readonly ModelMessage[]) => sourceRequests.get(messages);
export const compactMessages = (messages: readonly ModelMessage[]): ModelMessage[] => {
  if (!messages.length) return [];
  const sources = captureTaskSources({ zhivexTaskSources: sourceRequests.get(messages) ?? [] }, messages);
  const compacted: ModelMessage[] = [{ role: "user", parts: [{ type: "text",
    text: `${PREFIX}${summarizeHarnessMessages(messages).summary}` }] }];
  sourceRequests.set(compacted, sources);
  return compacted;
};
