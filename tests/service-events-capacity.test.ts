import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { resolveHarnessConfig, type HarnessConfig } from "../src/runtime/config.js";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { observeHarnessPolicyDecisions } from "../src/runtime/policy-decisions.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { openHarnessActivityStore, type HarnessActivityEvent, type HarnessActivitySnapshot, type HarnessActivityStore } from "../src/client/service-events.js";
import { createHarnessClientAdapter } from "../src/client/adapter.js";

const CAP = 2 * 1024 * 1024;
const snapshot = (config: HarnessConfig, session = "s") => {
  const db = new SqliteDatabase(`${config.stateDirectory}/operations.sqlite`);
  try {
    const encoded = db.query<{ snapshot: string }>("SELECT snapshot FROM client_activity_snapshots WHERE session=?").get(session)!.snapshot;
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(CAP);
    return JSON.parse(encoded) as HarnessActivitySnapshot;
  } finally { db.close(); }
};
const replayAll = (store: HarnessActivityStore): HarnessActivityEvent[] => {
  const events: HarnessActivityEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = store.replay("s", cursor);
    expect(page.cursorExpired).toBe(false);
    expect(page.policyEvidenceIncomplete).toBe(false);
    events.push(...page.events);
    if (!page.hasMore) return events;
    expect(page.nextCursor).toBeGreaterThan(cursor);
    cursor = page.nextCursor;
  }
};
const seedHistory = (store: HarnessActivityStore, count = 9, session = "s") => {
  for (let r = 0; r < count; r++) {
    for (let i = 0; i < 5; i++) store.append(session, `old${r}`, { type: "text-delta", textDelta: "word ".repeat(10_000) });
    store.checkpoint(session, `old${r}`, r === 0 ? "waiting_approval" : "completed");
  }
};
const decision = { schemaVersion: 1 as const, type: "policy-decision" as const, phase: "tool-entry" as const,
  toolName: "read_file", decision: "deny" as const, ruleIds: ["private"], reason: "Denied by policy", reasonTruncated: false,
  policyDigest: null, source: "baseline" as const, approvalRequired: false, explicitReviewRequired: false,
  executionBackend: "none" as const, evidence: "policy-evaluation" as const };

test("crossing 2 MiB compacts only the snapshot and preserves replay, receipts, statuses and restart", async () => {
  const root = await mkdtemp("/tmp/har-activity-cap-");
  const config = resolveHarnessConfig({ workspace: root });
  let store = await openHarnessActivityStore(config);
  try {
    store.policyDecision("s", "old0", decision);
    store.append("s", "old0", { type: "tool-result", toolResult: { toolCallId: "check", toolName: "run_check", isError: false, output: { exitCode: 7, timedOut: false } } });
    seedHistory(store);
    const projected = snapshot(config);
    expect(Object.keys(projected.runs)).toHaveLength(9);
    expect(projected.runs.old0).toMatchObject({ status: "waiting_approval", truncated: true, text: "" });
    expect(projected.runs.old0?.tools?.["tool:check"]).toMatchObject({ status: "failed", exitCode: 7 });
    expect(projected.runs.old8?.text.length).toBe(250_000);
    const journal = replayAll(store);
    expect(journal.filter(e => e.activity.type === "policy-decision")).toHaveLength(1);
    expect(journal.map(e => e.activity.textDelta ?? "").join("").length).toBe(2_250_000);
    expect(new Set(journal.map(e => e.eventId)).size).toBe(journal.length);
    // A resumed oldest run is protected as the current run rather than evicted by insertion order.
    store.append("s", "old0", { type: "text-delta", textDelta: "resumed ".repeat(30_000) });
    store.checkpoint("s", "old0", "completed");
    const resumed = snapshot(config);
    expect(resumed.runs.old0?.text.length).toBe(240_000);
    expect(resumed.runs.old0?.truncated).toBe(true);
    expect(resumed.runs.old1?.text).toBe("");
    const retained = replayAll(store);
    store.close(); store = await openHarnessActivityStore(config);
    expect(snapshot(config)).toEqual(resumed);
    expect(replayAll(store)).toEqual(retained);
    expect(store.replay("s", retained.at(-1)!.sequence).events).toHaveLength(0);
    // Real retention expiry, unlike snapshot compaction, explicitly loses journal coverage.
    store.close(); store = await openHarnessActivityStore(config, { maxEvents: 2 });
    const expired = store.replay("s");
    expect(expired.cursorExpired).toBe(true);
    expect(expired.policyEvidenceIncomplete).toBe(true);
    expect(expired.snapshot).toEqual(resumed);
    store.close(); store = await openHarnessActivityStore(config, { maxEvents: 2 });
    expect(store.replay("s", expired.nextCursor)).toMatchObject({ cursorExpired: false, policyEvidenceIncomplete: true, events: [] });
    store.checkpoint("s", "old0", "cancelled");
    expect(store.replay("s", expired.nextCursor).events).toHaveLength(1);
    expect(snapshot(config).runs.old0?.status).toBe("cancelled");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

for (const spare of [0, 1]) test(`snapshot byte boundary includes final sequence digit growth (spare=${spare})`, async () => {
  const root = await mkdtemp("/tmp/har-activity-exact-");
  const config = resolveHarnessConfig({ workspace: root });
  const store = await openHarnessActivityStore(config);
  try {
    store.checkpoint("s", "r8", "running");
    const seeded: HarnessActivitySnapshot = { schemaVersion: 1, sessionId: "s", sequence: 9, runs: {} };
    for (let i = 0; i < 9; i++) seeded.runs[`r${i}`] = { text: i < 8 ? "x".repeat(250_000) : "", status: "running", truncated: false };
    seeded.runs.r8!.text = "x".repeat(CAP - spare - Buffer.byteLength(JSON.stringify(seeded)));
    expect(Buffer.byteLength(JSON.stringify(seeded))).toBe(CAP - spare);
    const db = new SqliteDatabase(`${config.stateDirectory}/operations.sqlite`);
    try {
      db.query("UPDATE client_activity_snapshots SET snapshot=?,sequence=9 WHERE session=?").run(JSON.stringify(seeded), "s");
      db.query("UPDATE sqlite_sequence SET seq=9 WHERE name=?").run("client_activity_events");
    } finally { db.close(); }
    store.checkpoint("s", "r8", "running");
    const final = snapshot(config);
    expect(final.sequence).toBe(10);
    expect(final.runs.r8).toEqual(seeded.runs.r8);
    expect(final.runs.r0?.truncated).toBe(spare === 0);
    if (spare === 1) expect(Buffer.byteLength(JSON.stringify(final))).toBe(CAP);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("oversized text is split after redaction with bounded JSON and intact Unicode", async () => {
  const root = await mkdtemp("/tmp/har-activity-chunks-");
  const config = resolveHarnessConfig({ workspace: root });
  const secret = "private phrase value";
  const store = await openHarnessActivityStore(config, { sensitiveValues: [secret] });
  try {
    const prefix = "a" + "🙂 \u0000 ".repeat(20_000);
    store.append("s", "r", { type: "text-delta", textDelta: prefix + "private phrase " });
    store.append("s", "r", { type: "text-delta", textDelta: "value next " + "z".repeat(12_000) });
    store.checkpoint("s", "r", "completed");
    const events = replayAll(store);
    expect(events.map(e => e.activity.textDelta ?? "").join("")).toBe(prefix + "[REDACTED] next " + "z".repeat(12_000));
    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event.activity))).toBeLessThanOrEqual(64 * 1024);
      if (typeof event.activity.textDelta === "string") expect(event.activity.textDelta).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    expect(JSON.stringify(events)).not.toContain(secret);
    expect((await readFile(`${config.stateDirectory}/operations.sqlite`)).includes(Buffer.from(secret))).toBe(false);
    // Both terminal event flush paths must also accept a large unfinished word.
    const state = { schemaVersion: 1 as const, runId: "r", provider: "mock", modelId: "mock-model", status: "completed" as const,
      messages: [], steps: [], toolResults: [], currentStep: 0, maxSteps: 1, outputText: "", pendingApprovals: [] };
    for (const terminal of [{ type: "error" as const, error: new Error("fixture") }, { type: "agent-run-finish" as const, state, status: "completed" as const }]) {
      store.append("s", "r", { type: "text-delta", textDelta: "q".repeat(12_000) });
      store.append("s", "r", terminal);
    }
    expect(replayAll(store).map(e => e.activity.textDelta ?? "").join("")).toContain("q".repeat(24_000));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot exhaustion does not suppress policy validation, oversized non-text or database errors", async () => {
  const root = await mkdtemp("/tmp/har-activity-required-");
  const config = resolveHarnessConfig({ workspace: root });
  const store = await openHarnessActivityStore(config);
  let closed = false;
  try {
    seedHistory(store);
    const before = replayAll(store);
    expect(() => store.policyDecision("s", "old8", { ...decision, decision: "invalid" } as unknown as typeof decision)).toThrow();
    expect(() => store.append("s", "old8", { type: "tool-call", toolCall: { id: "too-large", name: "a".repeat(70_000), input: {} } })).toThrow("ACTIVITY_TOO_LARGE");
    expect(replayAll(store)).toEqual(before);
    store.close(); closed = true;
    expect(() => store.checkpoint("s", "old8", "completed")).toThrow();
  } finally { if (!closed) store.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

for (const payload of ["prompts", "tools", "current-tools"] as const) test(`bounded snapshot fallback covers ${payload}`, async () => {
  const root = await mkdtemp("/tmp/har-activity-fallback-");
  const config = resolveHarnessConfig({ workspace: root });
  const store = await openHarnessActivityStore(config);
  try {
    store.checkpoint("s", "current", "running");
    const seeded: HarnessActivitySnapshot = { schemaVersion: 1, sessionId: "s", sequence: 1, runs: {} };
    if (payload === "current-tools") {
      seeded.runs.current = { text: "", status: "running", truncated: false, prompt: "p".repeat(40_000), tools: {} };
      for (let i = 0; i < 32; i++) seeded.runs.current.tools![`tool:${i}`] = { name: "n".repeat(64_000), status: "completed" };
    } else {
      for (let i = 0; i < 9; i++) {
        const run = { text: "", status: "completed", truncated: false, tools: {} } as HarnessActivitySnapshot["runs"][string];
        if (payload === "prompts") run.prompt = "p".repeat(60_000);
        for (let j = 0; j < (payload === "prompts" ? 8 : 11); j++) run.tools![`tool:${j}`] = { name: "n".repeat(20_000), status: "completed" };
        seeded.runs[`old${i}`] = run;
      }
      seeded.runs.current = { text: "", status: "running", truncated: false };
    }
    expect(Buffer.byteLength(JSON.stringify(seeded))).toBeLessThan(CAP);
    const db = new SqliteDatabase(`${config.stateDirectory}/operations.sqlite`);
    try { db.query("UPDATE client_activity_snapshots SET snapshot=? WHERE session=?").run(JSON.stringify(seeded), "s"); }
    finally { db.close(); }
    if (payload === "current-tools") store.append("s", "current", { type: "tool-call", toolCall: { id: "new", name: "n".repeat(64_000), input: {} } });
    else store.append("s", "current", { type: "text-delta", textDelta: "word ".repeat(24_000) });
    const final = snapshot(config);
    expect(Object.keys(final.runs)).toEqual(Object.keys(seeded.runs));
    for (const [id, run] of Object.entries(final.runs)) expect(run.status).toBe(seeded.runs[id]!.status);
    if (payload === "current-tools") expect(final.runs.current).toEqual({ text: "", status: "running", truncated: true });
    else {
      expect(final.runs.current?.text.length).toBe(120_000);
      expect(final.runs.old0?.truncated).toBe(true);
      if (payload === "prompts") { expect(final.runs.old0?.prompt).toBeUndefined(); expect(final.runs.old0?.tools).toEqual(seeded.runs.old0?.tools); }
      else expect(final.runs.old0?.tools).toBeUndefined();
    }
    // The synthetic seeded projection does not invent or delete journal records.
    expect(replayAll(store)[0]?.activity).toEqual({ type: "checkpoint", status: "running" });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const cancel of [false, true]) test(`fake-provider long execution survives snapshot compaction (cancel=${cancel})`, async () => {
  const root = await mkdtemp("/tmp/har-activity-run-");
  const runStore = createInMemoryAgentRunStore();
  const controller = new AbortController();
  let stopped = false;
  const model = createMockLanguageModel({ provider: "mock-provider", streamEvents: [
    [{ type: "tool-call", toolCall: { id: "list1", name: "list_files", input: { path: ".", limit: 10 } } }, { type: "finish", finishReason: "tool-calls" }],
    [{ type: "tool-call", toolCall: { id: "list2", name: "list_files", input: { path: ".", limit: 10 } } }, { type: "finish", finishReason: "tool-calls" }]
  ] });
  const original = model.stream!.bind(model);
  let calls = 0;
  model.stream = async input => {
    if (++calls <= 2) return original(input);
    return (async function* () {
      try {
        for (let i = 0; i < 23; i++) yield { type: "text-delta" as const, textDelta: "word ".repeat(2_000) };
        if (cancel) await new Promise<void>((_resolve, reject) => {
          const signal = input.abortSignal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { type: "finish" as const, finishReason: "stop" as const };
      } finally { stopped = true; }
    })();
  };
  const harness = await createHarness({ workspace: root, provider: "openai", store: runStore, modelInstance: model, env: {},
    compactionMaxMessages: 4, compactionKeepRecentMessages: 2, compactionMaxEstimatedInputTokens: 10_000 });
  let activity = await openHarnessActivityStore(harness.config);
  try {
    seedHistory(activity, 8);
    let delivered = 0, compactions = 0;
    const result = await observeHarnessPolicyDecisions(event => activity.policyDecision("s", "long", event), () => runHarness(harness, {
      runId: "long", scope: harness.config.scope, prompt: "Inspect twice", abortSignal: controller.signal
    }, {
      onEvent: event => {
        activity.append("s", "long", event);
        if (event.type === "agent-compaction") compactions++;
        if (event.type === "text-delta") {
          delivered += event.textDelta.length;
          if (cancel && delivered >= 210_000) controller.abort();
        }
      }
    }));
    activity.checkpoint("s", "long", result.status);
    // The aggregate UI history physically crosses 2 MiB. Each run remains under
    // the separate configured 4 MiB durable SDK state limit.
    expect(2_000_000 + delivered).toBeGreaterThan(CAP);
    expect(stopped).toBe(true);
    expect(result.status).toBe(cancel ? "cancelled" : "completed");
    expect(result.error).toBeUndefined();
    expect(compactions).toBeGreaterThan(0);
    // Cancellation restores the last durable checkpoint; a compaction in the
    // unfinished step is visible in activity but need not survive in run state.
    if (!cancel) expect(result.state.compactions?.length).toBeGreaterThan(0);
    expect((await runStore.load("long", harness.config.scope))?.status).toBe(result.status);
    expect(await runStore.acquireLease!("long", { ownerId: "after-long", ttlMs: 1000 }, harness.config.scope)).toBeTruthy();
    await runStore.releaseLease!("long", "after-long", harness.config.scope);
    const projected = snapshot(harness.config);
    expect(projected.runs.long?.status).toBe(result.status);
    expect(projected.runs.old0?.truncated).toBe(true);
    const events = replayAll(activity);
    expect(events.filter(e => e.runId === "long").map(e => e.activity.textDelta ?? "").join("").length).toBe(delivered);
    activity.close(); activity = await openHarnessActivityStore(harness.config);
    expect(snapshot(harness.config)).toEqual(projected);
    expect(replayAll(activity)).toEqual(events);
  } finally { activity.close(); await harness.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("real client adapter completes past the history cap without duplicate execution and recovers its session", async () => {
  const root = await mkdtemp("/tmp/har-activity-client-");
  const model = () => createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "word ".repeat(40_000) }, { type: "finish", finishReason: "stop" }]] });
  let harness = await createHarness({ workspace: root, modelInstance: model(), env: {} });
  let activity = await openHarnessActivityStore(harness.config);
  const options = {
    onPrompt: (s: string, r: string, prompt: string) => activity.prompt(s, r, prompt),
    onEvent: (s: string, r: string, event: Parameters<HarnessActivityStore["append"]>[2]) => activity.append(s, r, event),
    onPolicyDecision: (s: string, r: string, event: Parameters<HarnessActivityStore["policyDecision"]>[2]) => activity.policyDecision(s, r, event),
    onCheckpoint: (s: string, r: string, status: string) => activity.checkpoint(s, r, status)
  };
  let adapter = await createHarnessClientAdapter(harness, options);
  try {
    const hello = adapter.negotiate([1]); if (!hello.ok) throw new Error("negotiation failed");
    const base = { protocolVersion: 1, connectionId: hello.connectionId };
    const created = await adapter.dispatch({ ...base, requestId: "create", command: { method: "session.create", projectId: hello.projectId, idempotencyKey: "create" } });
    if (!created.ok || created.data.kind !== "session") throw new Error("session fixture failed");
    const session = created.data.session;
    seedHistory(activity, 8, session.sessionId);
    const request = { ...base, requestId: "start", command: { method: "run.start" as const, projectId: hello.projectId,
      sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: "start", prompt: "Emit scripted text" } };
    const completed = await adapter.dispatch(request);
    if (!completed.ok || completed.data.kind !== "run") throw new Error("run fixture failed");
    expect(completed.data.run.status).toBe("completed");
    expect(snapshot(harness.config, session.sessionId).runs[completed.data.run.runId]?.status).toBe("completed");
    expect(await adapter.dispatch({ ...request, requestId: "duplicate" })).toEqual({ ...completed, requestId: "duplicate" });
    expect(harness.workspace.mutationAudit()).toHaveLength(0);
    const projection = snapshot(harness.config, session.sessionId);
    adapter.close(); activity.close(); await harness.close();
    harness = await createHarness({ workspace: root, modelInstance: model(), env: {} });
    activity = await openHarnessActivityStore(harness.config);
    adapter = await createHarnessClientAdapter(harness, options);
    const reopened = adapter.negotiate([1]); if (!reopened.ok) throw new Error("reopened negotiation failed");
    const fetched = await adapter.dispatch({ protocolVersion: 1, connectionId: reopened.connectionId, requestId: "get",
      command: { method: "session.get", projectId: reopened.projectId, sessionId: session.sessionId } });
    if (!fetched.ok || fetched.data.kind !== "session") throw new Error("reopened session missing");
    expect(fetched.data.session.runs).toHaveLength(1);
    expect(fetched.data.session.runs[0]?.status).toBe("completed");
    expect(snapshot(harness.config, session.sessionId)).toEqual(projection);
  } finally { adapter.close(); activity.close(); await harness.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
