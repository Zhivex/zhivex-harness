import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { startAssistantHost } from "../src/host.js";
import { connectAssistant } from "../src/client.js";
import { acquireAssistantProjectOwner } from "../src/projects.js";
import type { AssistantApplicationResult } from "../src/application-contracts.js";
import type { HarnessClientResponse } from "@zhivex-ai/harness/protocol";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const unwrap = <T>(value: AssistantApplicationResult<T>) => { if (!value.ok) throw new Error(value.error.code); return value.data; };
function session(value: HarnessClientResponse) {
  if (!value.ok || value.data.kind !== "session") throw new Error(JSON.stringify(value));
  return value.data.session;
}
async function fixture() {
  const root = await mkdtemp("/tmp/as-proj-");
  for (const name of ["a", "b"]) {
    await mkdir(`${root}/${name}`);
    await exec("git", ["init", "-q", `${root}/${name}`]);
    await writeFile(`${root}/${name}/note.txt`, "before");
    await writeFile(`${root}/${name}/package.json`, JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  }
  return root;
}
const coding = () => ({ execution: "local" as const, configurationId: "fixture-v1", engine: { provider: "openai", modelInstance: createMockLanguageModel() } });
async function register(host: Awaited<ReturnType<typeof startAssistantHost>>, selected: string) {
  return unwrap(await host.application!.client.registerProject(await host.application!.selectProject(selected)));
}

test("general and two projects retain separate bindings, reject scope overrides and survive restart", async () => {
  const root = await fixture(); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  const options = { directory: root + "/host", ownerId: "owner", engine: { modelInstance: createMockLanguageModel() }, coding: coding() };
  try {
    host = await startAssistantHost(options);
    const app = host.application!, a = await register(host, root + "/a"), b = await register(host, root + "/b");
    await symlink(root + "/a", root + "/alias");
    expect((await register(host, root + "/alias")).projectKey).toBe(a.projectKey);
    expect(unwrap(await app.client.projects())).toHaveLength(2);
    const general = unwrap(await app.client.createConversation({ context: { kind: "general" }, idempotencyKey: "general" }));
    const first = unwrap(await app.client.createConversation({ context: { kind: "project", projectKey: a.projectKey }, idempotencyKey: "a" }));
    const second = unwrap(await app.client.createConversation({ context: { kind: "project", projectKey: b.projectKey }, idempotencyKey: "b" }));
    expect(new Set([general.engineProjectId, first.engineProjectId, second.engineProjectId]).size).toBe(3);
    expect(unwrap(await app.client.snapshot(general.conversationId)).capabilities.capabilities["file-edit"].available).toBe(false);
    expect(unwrap(await app.client.snapshot(first.conversationId)).capabilities.capabilities["file-edit"].available).toBe(true);
    expect(await app.client.command({ conversationId: first.conversationId, command: { method: "session.get", sessionId: second.sessionId } })).toMatchObject({ ok: false, error: { code: "BINDING_MISMATCH" } });
    expect(await app.client.command({ conversationId: first.conversationId, command: { method: "session.get", sessionId: first.sessionId, projectId: second.engineProjectId } } as never)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await app.client.command({ conversationId: first.conversationId, command: { method: "approval.resolve", sessionId: first.sessionId, runId: "run", expectedRevision: 0, idempotencyKey: "bad", decisions: [{ approvalId: "approval", digest: "0".repeat(64), approve: true }] } } as never)).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    const before = unwrap(await app.client.snapshot(first.conversationId));
    expect(unwrap(await app.client.command({ conversationId: first.conversationId, command: { method: "session.rename", sessionId: first.sessionId, expectedRevision: before.session.revision, title: "new", idempotencyKey: "rename" } })).ok).toBe(true);
    expect(unwrap(await app.client.command({ conversationId: first.conversationId, command: { method: "session.rename", sessionId: first.sessionId, expectedRevision: before.session.revision, title: "stale", idempotencyKey: "rename-stale" } }))).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    await expect(acquireAssistantProjectOwner(root + "/a", true)).rejects.toThrow("OWNERSHIP_CONFLICT");
    const other = await startAssistantHost({ ...options, directory: root + "/other" });
    try {
      const project = await register(other, root + "/a");
      await expect(other.application!.projectConnection(project.projectKey)).rejects.toThrow("OWNERSHIP_CONFLICT");
    } finally { await other.close(); }
    await host.close(); host = await startAssistantHost(options);
    const restored = unwrap(await host.application!.client.snapshot(first.conversationId));
    expect(restored.binding).toEqual(first); expect(restored.session.title).toBe("new");
    expect(unwrap(await host.application!.client.snapshot(general.conversationId)).binding).toEqual(general);
    expect(unwrap(await host.application!.client.snapshot(second.conversationId)).binding).toEqual(second);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test("selection tokens are one-use and project concurrency is bounded", async () => {
  const root = await fixture(); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    host = await startAssistantHost({ directory: root + "/host", ownerId: "owner", engine: { modelInstance: createMockLanguageModel() }, coding: { ...coding(), maxOpenProjects: 1 } });
    const app = host.application!, token = await app.selectProject(root + "/a");
    const a = unwrap(await app.client.registerProject(token));
    expect(await app.client.registerProject(token)).toMatchObject({ ok: false });
    expect(await app.client.registerProject({ path: root + "/b" } as never)).toMatchObject({ ok: false });
    const b = await register(host, root + "/b");
    await Promise.all([app.projectConnection(a.projectKey), app.projectConnection(a.projectKey)]);
    await expect(app.projectConnection(b.projectKey)).rejects.toThrow("RUNTIME_BUSY");
    expect(await app.client.createConversation({ context: { kind: "isolated-task", projectKey: a.projectKey, taskId: "task" }, idempotencyKey: "task" })).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

// Installed Assistant consumers do not include the separate Code product. The
// repository run verifies this cross-product journey; installed tests cover the host.
test.skipIf(!existsSync(repoRoot + "/packages/code/src/cli.ts"))("Code terminal edits and checks an Assistant-owned project; general and other files are unchanged", async () => {
  const root = await fixture(); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: { path: "note.txt", expectedDigest: "sha256:" + createHash("sha256").update("before").digest("hex"), oldText: "before", newText: "after" } } }, { type: "finish", finishReason: "tool-calls" }],
    [{ type: "tool-call", toolCall: { id: "check", name: "run_check", input: { check: "test", expectedScript: 'node -e "process.exit(0)"' } } }, { type: "finish", finishReason: "tool-calls" }],
    [{ type: "text-delta", textDelta: "Changed and checked." }, { type: "finish", finishReason: "stop" }],
  ] });
  try {
    host = await startAssistantHost({ directory: root + "/host", ownerId: "owner", engine: { modelInstance: createMockLanguageModel() }, coding: { ...coding(), engine: { provider: "openai", modelInstance: model } } });
    const a = await register(host, root + "/a"), app = host.application!;
    const connection = await app.projectConnection(a.projectKey);
    const cli = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "packages/code/src/cli.ts", ...args, "--service", connection.credentialsPath, "--json"], { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(stderr + stdout);
      return JSON.parse(stdout);
    };
    const started = await cli(["run", "Update note and check"]);
    expect(started.status).toBe("waiting_approval");
    expect(await readFile(root + "/a/note.txt", "utf8")).toBe("before");
    const raw = await connectAssistant(connection.credentialsPath);
    const list = await raw.command({ method: "session.list" });
    if (!list.ok || list.data.kind !== "sessions") throw new Error("no session");
    const s = list.data.sessions[0]!;
    const id = s.runs[0]!.runId;
    const edited = await cli(["resume", id, "--session", s.sessionId, "--approve"]);
    expect(edited.status).toBe("waiting_approval");
    expect(await readFile(root + "/a/note.txt", "utf8")).toBe("after");
    const completed = await cli(["resume", id, "--session", s.sessionId, "--approve"]);
    expect(completed.status).toBe("completed");
    const events = await raw.events(s.sessionId);
    expect(JSON.stringify(events)).toContain("run_check");
    const run = await raw.command({ method: "run.get", sessionId: s.sessionId, runId: id });
    expect(JSON.stringify(run)).toContain('"exitCode":0');
    expect(await readFile(root + "/b/note.txt", "utf8")).toBe("before");
    const conversations = unwrap(await app.client.conversations());
    expect(conversations.some(c => c.sessionId === s.sessionId && c.context.kind === "project")).toBe(true);
    const conversation = conversations.find(c => c.sessionId === s.sessionId)!;
    const outputs = await app.outputs({ conversationId: conversation.conversationId, runId: id });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ name: 'run_check', exitCode: 0 });
    expect(outputs[0]?.command).toContain('test');
    const general = await connectAssistant(host.credentialsPath);
    expect(await general.command({ method: "run.get", sessionId: s.sessionId, runId: id })).toMatchObject({ ok: false });
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test("a changed runtime configuration cannot silently adopt a project's existing history", async () => {
  const root = await fixture(); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  const options = { directory: root + "/host", ownerId: "owner", engine: { modelInstance: createMockLanguageModel() }, coding: coding() };
  try {
    host = await startAssistantHost(options); const project = await register(host, root + "/a");
    await host.application!.projectConnection(project.projectKey); await host.close();
    host = await startAssistantHost({ ...options, coding: { ...coding(), configurationId: "different" } });
    await expect(host.application!.projectConnection(project.projectKey)).rejects.toThrow("BINDING_MISMATCH");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("OCI bootstrap failure never falls back to local execution", async () => {
  const root = await fixture(); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    host = await startAssistantHost({ directory: root + "/host", ownerId: "owner", engine: { modelInstance: createMockLanguageModel() }, coding: {
      ...coding(), execution: "oci", engine: { provider: "openai", modelInstance: createMockLanguageModel(), ociRuntimeAdapter: {
        async inspectImage() { throw new Error("fixture: runtime unavailable"); },
        async run() { throw new Error("must not run"); }, async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; },
      } },
    } });
    const project = await register(host, root + "/a");
    expect(await host.application!.client.createConversation({ context: { kind: "project", projectKey: project.projectKey }, idempotencyKey: "create" })).toMatchObject({ ok: false, error: { code: "EXECUTION_UNAVAILABLE" } });
    expect(await readFile(root + "/a/note.txt", "utf8")).toBe("before");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("project mutation admission and cancellation are authoritative across independent clients", async () => {
  const root = await fixture(); let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = createMockLanguageModel();
  const original = model.stream!.bind(model);
  model.stream = async input => { entered(); await gate; return original(input); };
  try {
    host = await startAssistantHost({ directory: root + "/host", ownerId: "owner", engine: { modelInstance: createMockLanguageModel() }, coding: { ...coding(), engine: { provider: "openai", modelInstance: model } } });
    const project = await register(host, root + "/a"), app = host.application!;
    const connection = await app.projectConnection(project.projectKey);
    const first = await connectAssistant(connection.credentialsPath, { serialize: false });
    const second = await connectAssistant(connection.credentialsPath, { serialize: false });
    const s = session(await first.command({ method: "session.create", idempotencyKey: "create" }));
    const running = first.command({ method: "run.start", sessionId: s.sessionId, expectedRevision: s.revision, idempotencyKey: "start", prompt: "Wait" });
    await ready;
    expect(await second.command({ method: "session.create", idempotencyKey: "blocked" })).toMatchObject({ ok: false, error: { code: "BUSY" } });
    const active = session(await second.command({ method: "session.get", sessionId: s.sessionId }));
    const ref = active.runs.at(-1)!;
    const run = await second.command({ method: "run.get", sessionId: s.sessionId, runId: ref.runId });
    if (!run.ok || run.data.kind !== "run") throw new Error("missing active run");
    const cancel = await second.command({ method: "run.cancel", sessionId: s.sessionId, runId: ref.runId, expectedRevision: run.data.run.revision, idempotencyKey: "cancel" });
    expect(cancel.ok).toBe(true);
    release(); await running;
    expect(await second.command({ method: "run.get", sessionId: s.sessionId, runId: ref.runId })).toMatchObject({ ok: true, data: { run: { status: "cancelled" } } });
  } finally { release(); await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("actual process crash requires recovery and preserves project approvals without replay", async () => {
  const root = await fixture();
  const children: ReturnType<typeof spawn>[] = [];
  const boot = async (mode: string) => {
    const child = spawn("node", [fileURLToPath(new URL("fixtures/project-process.mjs", import.meta.url)), root + "/host", root + "/a", mode], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const ended = once(child, "exit");
    let stderr = "", stdout = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([
        new Promise<string>(resolve => { child.stdout!.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) resolve(stdout.split("\n")[0]!); }); }),
        ended.then(() => { throw new Error(stderr); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("project fixture timeout")), 10000); }),
      ]);
      return { child, ended, connection: JSON.parse(line) as { credentialsPath: string } };
    } catch (error) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await ended; throw error; }
    finally { clearTimeout(timer); }
  };
  try {
    const first = await boot("propose");
    const client = await connectAssistant(first.connection.credentialsPath);
    const all = await client.command({ method: "session.list" });
    if (!all.ok || all.data.kind !== "sessions") throw new Error("missing session");
    const s = all.data.sessions[0]!, runId = s.runs[0]!.runId;
    const pending = await client.command({ method: "run.get", sessionId: s.sessionId, runId, includeReview: true });
    expect(pending).toMatchObject({ ok: true, data: { run: { status: "waiting_approval" } } });
    first.child.kill("SIGKILL"); await first.ended;
    await expect(boot("normal")).rejects.toThrow();
    const recovered = await boot("recover");
    const next = await connectAssistant(recovered.connection.credentialsPath);
    const restored = await next.command({ method: "run.get", sessionId: s.sessionId, runId, includeReview: true });
    if (!pending.ok || pending.data.kind !== "run" || !restored.ok || restored.data.kind !== "run") throw new Error("missing review");
    expect(restored.data.run.approvals).toEqual(pending.data.run.approvals);
    expect(restored.data.run.status).toBe("waiting_approval");
    expect(await readFile(root + "/a/note.txt", "utf8")).toBe("before");
    recovered.child.kill("SIGTERM"); await recovered.ended;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
