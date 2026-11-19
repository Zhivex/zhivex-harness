import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness } from "../packages/core/src/runtime/harness.js";
import { startApplicationHost } from "../packages/core/src/application/host.js";
import { startCodeHost } from "../packages/core/src/application/code/host.js";
import { connectApplication } from "../packages/core/src/application/client.js";
import type { HarnessClientResponse, HarnessClientData } from "../packages/core/src/client/protocol.js";

function data<K extends HarnessClientData["kind"]>(response: HarnessClientResponse, kind: K): Extract<HarnessClientData, { kind: K }> {
  if (!response.ok) throw new Error(response.error.code);
  if (response.data.kind !== kind) throw new Error("UNEXPECTED_RESPONSE");
  return response.data as Extract<HarnessClientData, { kind: K }>;
}

test("independent clients share a durable conversation and host-reviewed edit, without replaying receipts", async () => {
  const root = await mkdtemp("/tmp/zhx-app-");
  await writeFile(root + "/a.txt", "before\n");
  const model = () => createMockLanguageModel({ streamEvents: [[
    { type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: {
      path: "a.txt", expectedDigest: "sha256:" + createHash("sha256").update("before\n").digest("hex"), oldText: "before", newText: "after",
    } } }, { type: "finish", finishReason: "tool-calls" },
  ], [{ type: "text-delta", textDelta: "Updated the file." }, { type: "finish", finishReason: "stop" }]] });
  const boot = async () => {
    const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model(), subagentProfiles: [],
      toolPolicy: { schemaVersion: 1, explicitReview: { schemaVersion: 1 }, rules: [] } });
    try { return await startApplicationHost(harness, { directory: root + "/socket" }); }
    catch (error) { await harness.close(); throw error; }
  };
  let host = await boot();
  try {
    const cli = await connectApplication(host.credentialsPath), desktop = await connectApplication(host.credentialsPath);
    expect(cli.projectId).toBe(desktop.projectId);
    await expect(cli.command({ method: "session.list", projectId: "forged" })).rejects.toThrow("SCOPE_OVERRIDE");
    const session = data(await cli.command({ method: "session.create", idempotencyKey: "new", title: "Shared conversation" }), "session").session;
    expect(data(await desktop.command({ method: "session.list" }), "sessions").sessions[0]?.sessionId).toBe(session.sessionId);
    const run = data(await cli.command({ method: "run.start", sessionId: session.sessionId, expectedRevision: session.revision,
      idempotencyKey: "edit", prompt: "Update a.txt" }), "run").run;
    expect(run.status).toBe("waiting_approval");
    expect(await readFile(root + "/a.txt", "utf8")).toBe("before\n");
    const raw = await cli.command({ method: "approval.resolve", sessionId: session.sessionId, runId: run.runId,
      expectedRevision: run.revision, idempotencyKey: "bypass", decisions: run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) });
    expect(raw).toMatchObject({ ok: false, error: { code: "EXPLICIT_REVIEW_REQUIRED" } });
    const review = await desktop.review(session.sessionId, run.runId);
    if (!review.ok) throw new Error(review.error.code);
    expect(review.review.canApprove).toBe(true);
    expect(review.review.items[0]?.files[0]?.before).toBeDefined();
    await expect(cli.decide(review.review.ticketId, true)).rejects.toThrow();
    const decisions = await Promise.allSettled([
      desktop.decide(review.review.ticketId, true), desktop.decide(review.review.ticketId, true),
    ]);
    const accepted = decisions.filter(result => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(decisions.filter(result => result.status === 'rejected')).toHaveLength(1);
    const complete = data(accepted[0]!.value, "run").run;
    expect(complete.status).toBe("completed");
    expect(await readFile(root + "/a.txt", "utf8")).toBe("after\n");
    await expect(desktop.decide(review.review.ticketId, true)).rejects.toThrow();
    expect(data(await cli.command({ method: "run.get", sessionId: session.sessionId, runId: run.runId }), "run").run.status).toBe("completed");
    expect((await cli.events(session.sessionId)).events.length).toBeGreaterThan(0);
    await host.close();
    host = await boot();
    const reconnected = await connectApplication(host.credentialsPath);
    expect(data(await reconnected.command({ method: "session.get", sessionId: session.sessionId }), "session").session.title).toBe("Shared conversation");
    expect(data(await reconnected.command({ method: "run.get", sessionId: session.sessionId, runId: run.runId }), "run").run.status).toBe("completed");
    await expect(reconnected.decide(review.review.ticketId, true)).rejects.toThrow();
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("Code exports data and presentations only after the client approves the file payload", async () => {
  const root = await mkdtemp("/tmp/zhx-code-export-");
  const calls = [
    { id: "csv", name: "export_tabular_data", input: { path: "report.csv", columns: ["Total"], rows: [[125]], expectedDigest: null } },
    { id: "deck", name: "generate_presentation", input: { path: "report.html", title: "Report", slides: [{ title: "Quarterly results" }], expectedDigest: null } }
  ];
  const model = createMockLanguageModel({ streamEvents: [
    [...calls.map(toolCall => ({ type: "tool-call" as const, toolCall })), { type: "finish", finishReason: "tool-calls" }],
    [{ type: "text-delta", textDelta: "Done" }, { type: "finish", finishReason: "stop" }]
  ] });
  const host = await startCodeHost({ workspace: root, directory: root + "/socket", engine: {
    provider: "openai", modelInstance: model, subagentProfiles: [],
    toolPolicy: { schemaVersion: 1, explicitReview: { schemaVersion: 1 }, rules: [] }
  } });
  try {
    const client = await connectApplication(host.credentialsPath);
    const session = data(await client.command({ method: "session.create", idempotencyKey: "new" }), "session").session;
    const run = data(await client.command({ method: "run.start", sessionId: session.sessionId, expectedRevision: session.revision,
      idempotencyKey: "reports", prompt: "Export both reports" }), "run").run;
    expect(run.status).toBe("waiting_approval");
    const result = await client.review(session.sessionId, run.runId);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.review.canApprove).toBe(true);
    expect(result.review.items).toHaveLength(calls.length);
    for (const call of calls) {
      const item = result.review.items.find(item => item.name === call.name);
      expect(JSON.parse(item!.payload)).toMatchObject(call.input);
      expect(await Bun.file(path.join(root, call.input.path)).exists()).toBe(false);
    }
    expect(data(await client.decide(result.review.ticketId, true), "run").run.status).toBe("completed");
    expect(await readFile(root + "/report.csv", "utf8")).toBe("Total\n125\n");
    expect(await readFile(root + "/report.html", "utf8")).toContain("Quarterly results");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent clients receive authoritative revision conflicts", async () => {
  const root = await mkdtemp("/tmp/zhx-concurrent-");
  const harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel(), subagentProfiles: [] });
  const host = await startApplicationHost(harness, { directory: root + "/socket" });
  try {
    const a = await connectApplication(host.credentialsPath), b = await connectApplication(host.credentialsPath);
    const session = data(await a.command({ method: "session.create", idempotencyKey: "new" }), "session").session;
    const results = await Promise.all([a, b].map((client, i) => client.command({ method: "session.rename", sessionId: session.sessionId,
      expectedRevision: session.revision, idempotencyKey: `rename_${i}`, title: `Title ${i}` })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('Assistant core tools use host-authorized receipts and preserve tasks across restart', async () => {
  const { startAssistantHost } = await import('../packages/core/src/application/assistant/host.js');
  const { createDailyModule } = await import('../packages/core/src/application/assistant/modules/daily.js');
  const root = await mkdtemp('/tmp/zhx-assistant-review-');
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: 'tool-call', toolCall: { id: 'task', name: 'daily_write_create_task', input: { requestId: crypto.randomUUID(), title: 'Reviewed in Electron' } } }, { type: 'finish', finishReason: 'tool-calls' }],
    [{ type: 'text-delta', textDelta: 'Stored.' }, { type: 'finish', finishReason: 'stop' }],
  ] });
  let host = await startAssistantHost({ directory: root, ownerId: 'test', modules: [createDailyModule()], engine: { modelInstance: model } });
  try {
    const client = await connectApplication(host.credentialsPath);
    const session = data(await client.command({ method: 'session.create', idempotencyKey: 'new' }), 'session').session;
    const run = data(await client.command({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'task', prompt: 'Create a task' }), 'run').run;
    expect(host.daily?.listTasks().total).toBe(0);
    const review = await client.review(session.sessionId, run.runId);
    if (!review.ok) throw new Error(review.error.code);
    expect(review.review.canApprove).toBe(true);
    expect(review.review.items[0]?.payload).toContain('Reviewed in Electron');
    expect(data(await client.decide(review.review.ticketId, true), 'run').run.status).toBe('completed');
    expect(host.daily?.listTasks().total).toBe(1);
    await expect(client.decide(review.review.ticketId, true)).rejects.toThrow();
    await host.close();
    host = await startAssistantHost({ directory: root, ownerId: 'test', modules: [createDailyModule()], engine: { modelInstance: createMockLanguageModel() } });
    expect(host.daily?.listTasks().total).toBe(1);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
