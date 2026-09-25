import { expect, test } from "bun:test";
import type { HarnessClientAdapter } from "../src/client/protocol.js";
import { createAcpConnection } from "../src/client/acp.js";

const fixture = (permission: () => Promise<unknown> = async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } })) => {
  const commands: any[] = [], updates: any[] = [];
  let cancelled = false, approval = true;
  const session = { sessionId: "session_1", revision: 2 };
  const run = (status: string) => ({ kind: "run", session, run: { runId: "run_1", revision: 7, status, output: status === "completed" ? "done" : "", approvals: status === "waiting_approval" ? [
    { approvalId: "a1", digest: "a".repeat(64), action: { name: "apply_patch", arguments: "reviewed input" } }
  ] : [] } });
  const adapter: HarnessClientAdapter = {
    negotiate: () => ({ ok: true, protocolVersion: 1, connectionId: "c1", projectId: "p1", capabilities: [] }),
    cancelActive: async () => { cancelled = true; }, close() {},
    dispatch: async (request: any) => {
      const c = request.command; commands.push(c);
      const data = c.method === "session.create" || c.method === "session.get" ? { kind: "session", session } :
        c.method === "run.start" ? run(approval ? "waiting_approval" : "completed") :
        c.method === "run.cancel" ? run("cancelled") : run("completed");
      return { ok: true, requestId: request.requestId, protocolVersion: 1, data } as any;
    }
  };
  const connection = createAcpConnection(adapter, { workspace: "/workspace", notify: message => { updates.push(message); }, requestPermission: permission });
  let id = 0;
  const call = async (method: string, params: unknown) => connection.handle({ jsonrpc: "2.0", id: ++id, method, params }) as Promise<any>;
  const setup = async () => { await call("initialize", { protocolVersion: 1 }); return call("session/new", { cwd: "/workspace", mcpServers: [] }); };
  return { connection, commands, updates, call, setup, cancelled: () => cancelled, noApproval: () => { approval = false; } };
};

test("ACP negotiates text subset and routes approvals with exact revision and digest", async () => {
  const f = fixture(); await f.setup();
  const result = await f.call("session/prompt", { sessionId: "session_1", prompt: [{ type: "text", text: "fix" }] });
  expect(result.result).toEqual({ stopReason: "end_turn" });
  expect(f.commands.find(c => c.method === "approval.resolve")).toMatchObject({ expectedRevision: 7, decisions: [{ approvalId: "a1", digest: "a".repeat(64), approve: true }] });
  expect(f.updates[0].params.update.content.text).toBe("done");
});

test("reject once is preserved, never promoted into approval", async () => {
  const f = fixture(async () => ({ outcome: { outcome: "selected", optionId: "reject_once" } })); await f.setup();
  await f.call("session/prompt", { sessionId: "session_1", prompt: [{ type: "text", text: "fix" }] });
  expect(f.commands.find(c => c.method === "approval.resolve").decisions[0].approve).toBe(false);
});

test("uninitialized requests, foreign workspaces, MCP and unsupported content are rejected", async () => {
  const f = fixture();
  expect((await f.call("session/new", { cwd: "/workspace", mcpServers: [] })).error.code).toBe(-32002);
  const initialized = await f.call("initialize", { protocolVersion: 1 });
  expect(initialized.result.agentCapabilities.loadSession).toBe(false);
  expect(initialized.result._meta.zhivex.subset).toBe(true);
  expect((await f.call("session/new", { cwd: "/other", mcpServers: [] })).error.code).toBe(-32602);
  expect((await f.call("session/new", { cwd: "/workspace", mcpServers: [{ command: "evil" }] })).error.code).toBe(-32602);
  await f.setup();
  expect((await f.call("session/prompt", { sessionId: "session_1", prompt: [{ type: "image", data: "abc" }] })).error.code).toBe(-32602);
  expect((await f.call("session/load", {})).error.code).toBe(-32601);
  expect(f.commands.filter(c => c.method === "run.start")).toHaveLength(0);
});

test("cancel notification interrupts pending permission without granting or awaiting client", async () => {
  let requested!: () => void;
  const ready = new Promise<void>(resolve => { requested = resolve; });
  const f = fixture(async () => { requested(); return new Promise(() => {}); }); await f.setup();
  const pending = f.call("session/prompt", { sessionId: "session_1", prompt: [{ type: "text", text: "fix" }] });
  await ready;
  expect((await f.call("session/prompt", { sessionId: "session_1", prompt: [{ type: "text", text: "duplicate" }] })).error.message).toBe("BUSY");
  expect(await f.connection.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "session_1" } })).toBeUndefined();
  expect((await pending).result.stopReason).toBe("cancelled");
  expect(f.cancelled()).toBe(true);
  expect(f.commands.some(c => c.method === "run.cancel")).toBe(true);
  expect(f.commands.some(c => c.method === "approval.resolve")).toBe(false);
});

test("malformed permission responses never authorize, mutating notifications never run", async () => {
  const f = fixture(async () => ({ outcome: { outcome: "selected", optionId: "allow_always" } })); await f.setup();
  expect((await f.call("session/prompt", { sessionId: "session_1", prompt: [{ type: "text", text: "fix" }] })).error.code).toBe(-32602);
  expect(f.commands.some(c => c.method === "approval.resolve")).toBe(false);
  const before = f.commands.length;
  await f.connection.handle({ jsonrpc: "2.0", method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
  expect(f.commands).toHaveLength(before);
});

test("ACP approval runs through real durable harness adapter before changing files", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const { createMockLanguageModel } = await import("@zhivex-ai/agents/testing");
  const { createHarness } = await import("../src/runtime/harness.js");
  const { createHarnessClientAdapter } = await import("../src/client/adapter.js");
  const workspace = await mkdtemp(tmpdir() + "/acp-integration-");
  await writeFile(workspace + "/a.txt", "before\n");
  const model = createMockLanguageModel({ streamEvents: [[
    { type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: { path: "a.txt",
      expectedDigest: "sha256:" + createHash("sha256").update("before\n").digest("hex"), oldText: "before", newText: "after" } } },
    { type: "finish", finishReason: "tool-calls" }
  ], [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }]] });
  const harness = await createHarness({ workspace, provider: "openai", modelInstance: model, subagentProfiles: [] });
  const adapter = await createHarnessClientAdapter(harness);
  let approvals = 0;
  try {
    const acp = createAcpConnection(adapter, { workspace, notify() {}, requestPermission: async () => {
      expect(await readFile(workspace + "/a.txt", "utf8")).toBe("before\n"); approvals++;
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    } });
    await acp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const session: any = await acp.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workspace, mcpServers: [] } });
    const done: any = await acp.handle({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: session.result.sessionId, prompt: [{ type: "text", text: "Change a.txt" }] } });
    expect(done.result).toEqual({ stopReason: "end_turn" });
    expect(approvals).toBe(1);
    expect(await readFile(workspace + "/a.txt", "utf8")).toBe("after\n");
    expect(harness.workspace.mutationAudit()).toHaveLength(1);
  } finally { adapter.close(); await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});

for (const permissionTimesOut of [false, true]) test(`stdio transport correlates permissions and cancellation (timeout=${permissionTimesOut})`, async () => {
  const { PassThrough } = await import("node:stream");
  const { serveAcpStdio } = await import("../src/client/acp-stdio.js");
  // Access a minimal adapter through the same durable command contract.
  let approved = false;
  const adapter: HarnessClientAdapter = {
    negotiate: () => ({ ok: true, protocolVersion: 1, connectionId: "c", projectId: "p", capabilities: [] }),
    cancelActive: async () => {}, close() {}, dispatch: async (request: any) => {
      const c = request.command;
      if (c.method === "approval.resolve") approved = c.decisions[0].approve;
      return { protocolVersion: 1, requestId: request.requestId, ok: true, data:
        ["session.create", "session.get"].includes(c.method) ? { kind: "session", session: { sessionId: "s", revision: 1 } } :
          { kind: "run", session: { sessionId: "s", revision: 2 }, run: { runId: "r", revision: 1,
            status: approved ? "completed" : "waiting_approval", output: approved ? "done" : "", approvals: approved ? [] : [{ approvalId: "a", digest: "a".repeat(64), action: {} }] } }
      } as any;
    }
  };
  const input = new PassThrough(), output = new PassThrough();
  const messages: any[] = [];
  let buffer = "";
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  output.on("data", chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); messages.push(message);
      if (message.id === 1) send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
      if (message.id === 2) send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "fix" }] } });
      if (message.method === "session/request_permission" && !permissionTimesOut) send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
      if (message.id === 3) input.end();
    }
  });
  const serving = serveAcpStdio(adapter, { workspace: "/workspace", input, output, permissionTimeoutMs: 5 });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await serving;
  expect(approved).toBe(!permissionTimesOut);
  expect(messages.find(m => m.id === 3).result.stopReason).toBe(permissionTimesOut ? "cancelled" : "end_turn");
  expect(messages.every(m => m.jsonrpc === "2.0")).toBe(true);
});

test("stdio rejects oversized frames and requests cancellation", async () => {
  const { PassThrough } = await import("node:stream");
  const { serveAcpStdio } = await import("../src/client/acp-stdio.js");
  let cancelled = false;
  const adapter: HarnessClientAdapter = {
    negotiate: () => ({ ok: true, protocolVersion: 1, connectionId: "c", projectId: "p", capabilities: [] }),
    cancelActive: async () => { cancelled = true; }, close() {}, dispatch: async () => { throw new Error("must not dispatch"); }
  };
  const input = new PassThrough(), output = new PassThrough();
  const serving = serveAcpStdio(adapter, { workspace: "/workspace", input, output });
  input.end("x".repeat(1024 * 1024 + 1));
  await expect(serving).rejects.toThrow("exceeds 1 MiB");
  expect(cancelled).toBe(true);
});

test("permission callback aborts when a client cancels instead of retaining a pending request", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const adapter: HarnessClientAdapter = {
    negotiate: () => ({ ok: true, protocolVersion: 1, connectionId: "c", projectId: "p", capabilities: [] }),
    cancelActive: async () => {}, close() {}, dispatch: async (request: any) => ({ protocolVersion: 1, requestId: request.requestId, ok: true,
      data: ["session.create", "session.get"].includes(request.command.method) ? { kind: "session", session: { sessionId: "s", revision: 1 } } :
        { kind: "run", session: { sessionId: "s", revision: 2 }, run: { runId: "r", revision: 1, output: "", status: request.command.method === "run.cancel" ? "cancelled" : "waiting_approval", approvals: [{ approvalId: "a", digest: "a".repeat(64), action: {} }] } }
    } as any)
  };
  const connection = createAcpConnection(adapter, { workspace: "/workspace", notify() {}, requestPermission: async (_params, signal) => {
    started();
    signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } });
  await connection.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await connection.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
  const prompt = connection.handle({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "fix" }] } });
  await ready; await connection.cancelActive();
  expect(await prompt).toMatchObject({ result: { stopReason: "cancelled" } });
  expect(aborted).toBe(true);
});
