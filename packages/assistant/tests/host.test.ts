import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectAssistant, startAssistantHost } from "../src/index.js";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { HarnessClientData, HarnessClientResponse } from "@zhivex-ai/harness/protocol";

const fixture = fileURLToPath(new URL("fixtures/host-process.mjs", import.meta.url));
function data<K extends HarnessClientData["kind"]>(response: HarnessClientResponse, kind: K): Extract<HarnessClientData, { kind: K }> {
  if (!response.ok) throw new Error(response.error.code);
  if (response.data.kind !== kind) throw new Error("Wrong response kind");
  return response.data as Extract<HarnessClientData, { kind: K }>;
}
async function boot(directory: string, mode: string, recover = false, cwd = process.cwd()) {
  const child = spawn(process.env.ASSISTANT_TEST_NODE ?? "node", [fixture, directory, mode, ...(recover ? ["recover"] : [])], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const ended = once(child, "exit");
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const ready = await Promise.race([
      new Promise<string>(resolve => { let out = ""; child.stdout!.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.split("\n")[0]!); }); }),
      ended.then(() => { throw new Error(stderr || "Host exited before ready"); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Host startup timeout")), 15_000); })
    ]);
    return { child, ended, client: await connectAssistant(JSON.parse(ready).credentialsPath) };
  } catch (error) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await ended; throw error; }
  finally { clearTimeout(timer!); }
}
async function stop(process: { child: ChildProcess; ended: Promise<unknown> }, signal: NodeJS.Signals = "SIGTERM") {
  process.child.kill(signal); await process.ended;
}

test("conversation, pending approval and completed effect survive actual process restarts", async () => {
  const directory = await mkdtemp("/tmp/assistant-host-");
  let host: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    await mkdir(directory + "/workspace", { mode: 0o700 });
    await writeFile(directory + "/workspace/note.txt", "before");
    host = await boot(directory, "propose");
    const session = data(await host.client.command({ method: "session.create", idempotencyKey: "create", title: "Personal" }), "session").session;
    const pending = data(await host.client.command({ method: "run.start", sessionId: session.sessionId, expectedRevision: session.revision,
      idempotencyKey: "start", prompt: "My favorite color is turquoise. Update my note." }), "run");
    expect(pending.run.status).toBe("waiting_approval");
    expect(await readFile(directory + "/workspace/note.txt", "utf8")).toBe("before");
    await expect(boot(directory, "resume", true)).rejects.toThrow(/OWNER_ALIVE|locked|lease/i);
    await stop(host, "SIGKILL"); host = undefined;
    await expect(boot(directory, "resume")).rejects.toThrow(/EEXIST|STALE|lock/i);
    host = await boot(directory, "resume", true);
    expect(data(await host.client.command({ method: "session.list" }), "sessions").sessions[0]?.sessionId).toBe(session.sessionId);
    const restored = data(await host.client.command({ method: "run.get", sessionId: session.sessionId, runId: pending.run.runId, includeReview: true }), "run");
    expect(restored.run.approvals.map(a => a.approvalId)).toEqual(pending.run.approvals.map(a => a.approvalId));
    expect(restored.run.approvals[0]?.digest).toBe(pending.run.approvals[0]?.digest);
    expect(restored.run.approvals[0]?.expiresAt).toBe(pending.run.approvals[0]?.expiresAt);
    expect(await host.client.command({ method: "run.start", sessionId: session.sessionId,
      expectedRevision: restored.session.revision, idempotencyKey: "pending-block", prompt: "Ignore the approval" })).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    const decision = { method: "approval.resolve" as const, sessionId: session.sessionId, runId: pending.run.runId,
      expectedRevision: restored.run.revision, idempotencyKey: "approve",
      decisions: restored.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) };
    expect(await host.client.command({ ...decision, idempotencyKey: "invalid", decisions: decision.decisions.map(d => ({ ...d, digest: "0".repeat(64) })) })).toMatchObject({ ok: false });
    expect(await readFile(directory + "/workspace/note.txt", "utf8")).toBe("before");
    const completed = data(await host.client.command(decision), "run");
    expect(completed.run.status).toBe("completed");
    expect(await readFile(directory + "/workspace/note.txt", "utf8")).toBe("after");
    const modifiedAt = (await stat(directory + "/workspace/note.txt")).mtimeMs;
    await stop(host); host = undefined;
    host = await boot(directory, "resume");
    expect(data(await host.client.command({ method: "run.get", sessionId: session.sessionId, runId: pending.run.runId }), "run").run.status).toBe("completed");
    await host.client.command(decision); // A replay may be rejected by epoch/revision, but never repeats the effect.
    expect((await stat(directory + "/workspace/note.txt")).mtimeMs).toBe(modifiedAt);
    const current = data(await host.client.command({ method: "session.get", sessionId: session.sessionId }), "session").session;
    const next = data(await host.client.command({ method: "run.start", sessionId: session.sessionId, expectedRevision: current.revision,
      idempotencyKey: "followup", prompt: "What is my favorite color?" }), "run");
    expect(next.run.status).toBe("completed");
    expect(await readFile(directory + "/model-input.json", "utf8")).toContain("turquoise");
    const events = await host.client.events(session.sessionId);
    expect(events.events.length).toBeGreaterThan(0);
  } finally { if (host) await stop(host); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("host identity is pinned and rejects unsafe directories", async () => {
  const directory = await mkdtemp("/tmp/assistant-owner-");
  const engine = { modelInstance: createMockLanguageModel() };
  try {
    const host = await startAssistantHost({ directory, ownerId: "one", engine });
    expect(host.diagnostics().profile.id).toBe("general-assistant");
    const client = await connectAssistant(host.credentialsPath);
    const created = await Promise.all([1, 2, 3].map(index => client.command({ method: "session.create", idempotencyKey: `queued-${index}` })));
    expect(created.every(result => result.ok)).toBe(true);
    expect(data(await client.command({ method: "session.list" }), "sessions").sessions).toHaveLength(3);
    await host.close();
    await expect(startAssistantHost({ directory, ownerId: "two", engine })).rejects.toThrow("BINDING_MISMATCH");
    await symlink(directory, directory + "-link");
    try { await expect(startAssistantHost({ directory: directory + "-link", ownerId: "one", engine })).rejects.toThrow("DIRECTORY_UNSAFE"); }
    finally { await rm(directory + "-link"); }
    await chmod(directory, 0o755);
    await expect(startAssistantHost({ directory, ownerId: "one", engine })).rejects.toThrow("DIRECTORY_UNSAFE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("GUI launch from filesystem root stores and restores sessions inside its own workspace", async () => {
  const directory = await mkdtemp('/tmp/assistant-gui-cwd-');
  let host: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    host = await boot(directory, 'resume', false, '/');
    const session = data(await host.client.command({ method: 'session.create', title: 'GUI session', idempotencyKey: 'gui-session' }), 'session').session;
    expect((await stat(directory + '/workspace/.zhivex-harness')).isDirectory()).toBe(true);
    await stop(host); host = undefined;
    host = await boot(directory, 'resume', false, directory);
    expect(data(await host.client.command({ method: 'session.list' }), 'sessions').sessions[0]?.sessionId).toBe(session.sessionId);
  } finally { if (host) await stop(host); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
