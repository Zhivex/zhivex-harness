/** Opt-in live conversation continuity across process restarts; no repository mutation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTextMessage, type JsonValue, type ModelMessage } from "@zhivex-ai/core";
import { loadLiveSmokeRuntime } from "./live-smoke-runtime.js";
import type { HarnessProvider } from "../src/runtime/config.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";

assert.equal(process.env.ZHIVEX_HARNESS_LIVE, "1", "Set ZHIVEX_HARNESS_LIVE=1 to authorize bounded provider requests.");
const api = await loadLiveSmokeRuntime();
const providers = ["openai", "qwen", "meta"] as const;
const objectives = ["diagnose-parser", "design-cache", "review-api", "profile-parser", "implement-cache", "audit-contract"];
const limits = { maxInputTokens: 24_000, maxOutputTokens: 8192, maxTotalTokens: 32_192, maxTokens: 8192,
  maxSteps: 2, timeoutMs: 90_000, compactionMaxMessages: 5, compactionKeepRecentMessages: 2, compactionMaxEstimatedInputTokens: 12_000 };
const initial = "Project codename: ORCHID-742. Required compatibility: keep-public-api. Rejected approach: schema-rewrite. Initial objective: diagnose-parser. Retain these project facts for later turns.";
const finalPrompt = "Return one JSON object with exactly codename, compatibility, rejectedApproach, objective. Recover the first three values from prior conversation and set objective to the most recent user objective. Do not use tools. No prose.";
const noise = (): ModelMessage[] => Array.from({ length: 6 }, (_, i) => createTextMessage(i % 2 ? "assistant" : "user",
  i % 2 ? "Temporary observation recorded; no change to project facts or objective." : "Temporary discussion: presentation wording is nonbinding; project facts and objective remain unchanged."));
type Session = { messages: ModelMessage[]; metadata?: Record<string, JsonValue>; turns: number };

if (process.argv[2] === "--child") {
  const [providerArg, model, root, phaseArg] = process.argv.slice(3);
  assert(providers.includes(providerArg as typeof providers[number]) && model && root && phaseArg);
  const provider = providerArg as HarnessProvider;
  const phase = Number(phaseArg);
  assert(Number.isSafeInteger(phase) && phase >= 0 && phase < objectives.length);
  const sessionPath = path.join(root, "session.json");
  const session: Session = phase ? JSON.parse(await readFile(sessionPath, "utf8")) : { messages: [], turns: 0 };
  assert.equal(session.turns, phase, "Every turn must load its predecessor's durable conversation.");
  const history = [...session.messages,
    createTextMessage("user", phase ? `Change the active objective to ${objectives[phase]}. ${phase === 1 ? "Correction: project codename is now ORCHID-913, replacing ORCHID-742." : "Keep the corrected project codename."} Preserve compatibility and the rejected approach; this replaces the previous objective.` : initial),
    ...noise(), createTextMessage("user", finalPrompt)];
  let harness: Awaited<ReturnType<typeof api.createHarness>> | undefined;
  try {
  harness = await api.createHarness({ provider, model, workspace: root, stateDirectory: path.join(root, "state"),
    subagentProfiles: [], toolNames: ["read_task"], requireVerifiedDelivery: false, projectContext: false,
    maxSteps: limits.maxSteps, timeoutMs: limits.timeoutMs, maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens, maxTotalTokens: limits.maxTotalTokens,
    compactionMaxMessages: limits.compactionMaxMessages, compactionKeepRecentMessages: limits.compactionKeepRecentMessages,
    compactionMaxEstimatedInputTokens: limits.compactionMaxEstimatedInputTokens });
    const result = await api.runHarness(harness, { messages: history, metadata: session.metadata ?? {},
      maxTokens: limits.maxTokens, abortSignal: AbortSignal.timeout(limits.timeoutMs),
      ...(provider === "openai" ? { providerOptions: { apiMode: "responses" } }
        : provider === "qwen" ? { providerOptions: { apiMode: "chat" } } : {}) });
    const text = result.outputText.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    let answer: Record<string, unknown> = {};
    try { answer = JSON.parse(text); } catch { /* The report records only the failed shape, never provider text. */ }
    const checks = { completed: result.status === "completed", compacted: (result.state.compactions?.length ?? 0) > 0,
      codename: answer.codename === (phase ? "ORCHID-913" : "ORCHID-742"), compatibility: answer.compatibility === "keep-public-api",
      rejectedApproach: answer.rejectedApproach === "schema-rewrite", objective: answer.objective === objectives[phase],
      noTools: result.toolResults.length === 0 };
    const saved = await harness.store.load(result.state.runId, result.state.scope);
    assert(saved, "Harness checkpoint missing after provider request.");
    const compactedContext = result.state.compactions?.at(-1)?.summary ?? "";
    let projected: { objective?: string; steering?: string[]; contextPriority?: string } = {};
    try { projected = JSON.parse(compactedContext); } catch { /* No raw context is published. */ }
    const retainedContext = {
      initialFactPresent: compactedContext.includes("ORCHID-742"),
      correctedFactPresent: compactedContext.includes("ORCHID-913"),
      userCorrectionPresent: (projected.steering ?? []).some(value => value.includes("ORCHID-913")),
      currentObjectivePresent: `${projected.objective ?? ""}\n${(projected.steering ?? []).join("\n")}`.includes(objectives[phase]!),
      compatibilityPresent: compactedContext.includes("keep-public-api"),
      rejectedApproachPresent: compactedContext.includes("schema-rewrite"),
      explicitContextPriority: typeof projected.contextPriority === "string"
    };
    await writeFile(sessionPath, JSON.stringify({ messages: saved.messages, ...(saved.metadata ? { metadata: saved.metadata } : {}), turns: phase + 1 } satisfies Session));
    await writeFile(path.join(root, `phase-${phase}.json`), JSON.stringify({ phase, checks,
      status: Object.values(checks).every(Boolean) ? "passed" : "failed", compactions: result.state.compactions?.length ?? 0,
      compactedMessages: result.state.compactions?.reduce((sum, item) => sum + item.compactedMessageCount, 0) ?? 0,
      inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null,
      finishReason: result.finishReason ?? null, answerJsonParsed: Object.keys(answer).length > 0,
      retainedContext,
      checkpointRestored: phase > 0, sourceDigest: createHash("sha256").update(JSON.stringify(history)).digest("hex") }));
  } catch (error) {
    await writeFile(path.join(root, `phase-${phase}.json`), JSON.stringify({ phase, status: "failed", diagnostic: sanitizeOperationalError(error) }));
    process.exitCode = 1;
  } finally { await harness?.close(); }
} else {
  const reportPath = path.resolve(process.argv[2] ?? "results/live-continuity.json");
  const rows: Record<string, unknown>[] = [];
  const selected = process.env.ZHIVEX_HARNESS_LIVE_PROVIDERS?.split(",").map(value => value.trim()) ?? [...providers];
  assert(selected.length > 0 && selected.every(provider => providers.includes(provider as typeof providers[number])), "Continuity scope is openai,qwen,meta only.");
  for (const provider of selected as typeof providers[number][]) {
    const descriptor = api.providerDescriptor(provider);
    const model = process.env[`ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`]?.trim() || descriptor.defaultModel;
    if (!descriptor.credentialNames.some(name => Boolean(process.env[name]?.trim()))) {
      rows.push({ provider, model, status: "missing_credentials" }); continue;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-live-continuity-"));
    const phases: Record<string, unknown>[] = [];
    const started = Date.now();
    try {
      for (let phase = 0; phase < objectives.length; phase++) {
        const child = Bun.spawn([process.execPath, path.resolve(import.meta.filename), "--child", provider, model, root, String(phase)],
          { env: process.env, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => child.kill(), 100_000);
        // Capture and discard raw provider failures; share only classification.
        const [exitCode] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        clearTimeout(timer);
        if (exitCode !== 0) {
          try { phases.push(JSON.parse(await readFile(path.join(root, `phase-${phase}.json`), "utf8"))); }
          catch { phases.push({ phase, status: "failed", reason: "child_request_or_runtime_failure", exitCode }); }
          break;
        }
        phases.push(JSON.parse(await readFile(path.join(root, `phase-${phase}.json`), "utf8")));
      }
      rows.push({ provider, model, status: phases.length === objectives.length && phases.every(item => item.status === "passed") ? "passed" : "failed",
        processStarts: phases.length, elapsedMs: Date.now() - started, phases });
    } finally { await rm(root, { recursive: true, force: true }); }
    process.stdout.write(`${provider}: ${rows.at(-1)!.status}\n`);
  }
  const report = { schemaVersion: 1, kind: "live-conversation-continuity", runtime: process.env.ZHIVEX_HARNESS_LIVE_RUNTIME ? "selected-artifact" : "source",
    harnessVersion: api.HARNESS_VERSION, observedAt: new Date().toISOString(), status: rows.every(row => row.status === "passed") ? "passed" : "failed",
    scriptSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex"), rows,
    limits, requireVerifiedDelivery: false,
    comparisonNote: "Post-fix campaign raises generation/output ceilings to 8192 from the prior six-turn campaign's 2048/4096 to isolate memory behavior; success rates are not directly comparable.",
    ...(process.env.ZHIVEX_HARNESS_LIVE_RUNTIME ? { moduleSha256: createHash("sha256").update(await readFile(process.env.ZHIVEX_HARNESS_LIVE_RUNTIME)).digest("hex") } : {}),
    limitations: ["Six-turn synthetic memory scenario with forced compaction; not a natural long-session benchmark or release certification", "Conversation restarts between completed runs; suspended approval resume is tested separately", "Deterministic compaction; no auxiliary paid compactor"] };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Sanitized evidence: ${reportPath}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
