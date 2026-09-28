// Copied into the clean package consumer and executed with Node. All runtime
// imports resolve from that consumer, never from the source checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import {
  createHarness, runHarness, createHarnessClientAdapter, createAcpConnection,
  compactHarnessMessages, Workspace, openCliSessionStore, openWorkspaceCheckpointStore
} from "@zhivex-ai/harness";

const turn = (id, name, input) => [
  { type: "tool-call", toolCall: { id, name, input } },
  { type: "finish", finishReason: "tool-calls" }
];
const done = [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }];
const approve = async approvals => approvals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
const fixture = async action => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "installed-release-contract-")));
  try { await writeFile(path.join(root, "a.txt"), "before\n"); await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
};

// A failed Meta stream must preserve its HTTP error and let Node exit naturally.
// Run in a child so a retained SDK timer cannot hide inside the test runner.
{
  const source = `
    import assert from "node:assert/strict";
    import { createProviderModel } from "@zhivex-ai/harness";
    globalThis.fetch = async () => Response.json({ error: { type: "server_error", message: "fixture" } }, { status: 503 });
    const model = createProviderModel({ provider: "meta", model: "muse-spark-1.3-contributor" }, { MODEL_API_KEY: "fixture" });
    await assert.rejects(model.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "fixture" }] }],
      timeoutMs: 60000, maxRetries: 0 }), error => error.status === 503);
    console.log("meta-failure-settled");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", value => stdout += value);
  child.stderr.on("data", value => stderr += value);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(timedOut, false, "Meta setup failure retained the process");
    assert.equal(code, 0, stderr);
    assert(stdout.includes("meta-failure-settled"));
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}

// Retained history must preserve current user direction without granting an edit.
const user = text => ({ role: "user", parts: [{ type: "text", text }] });
let history = [user("Fix pagination without changing the public API."), user("Preserve Unicode ordering too.")];
for (let round = 0; round < 4; round++) {
  history = compactHarnessMessages([...history, ...Array.from({ length: 30 }, () => ({
    role: "assistant", parts: [{ type: "text", text: "Inspecting dependencies." }]
  }))]);
}
const summary = JSON.stringify(history);
assert(summary.includes("without changing the public API"));
assert(summary.includes("Preserve Unicode ordering"));

// Actual installed executable and newline-delimited JSON-RPC transport. No
// prompt is sent, so the placeholder credential can never invoke a provider.
await fixture(async root => {
  const cli = fileURLToPath(new URL("./node_modules/.bin/zhx-acp", import.meta.url));
  const child = spawn(process.execPath, [cli, "--workspace", root, "--provider", "openai"], {
    cwd: root, env: { ...process.env, OPENAI_API_KEY: "offline-smoke-placeholder" }, stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "", count = 0;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Installed ACP transport timed out")); }, 10_000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", code => {
        clearTimeout(timeout);
        if (code !== 0 || count !== 3) reject(new Error(`Installed ACP transport failed (${code}, ${count} responses): ${stderr}`));
        else resolve();
      });
      lines.on("line", line => {
        try {
          const message = JSON.parse(line);
          assert.equal(message.jsonrpc, "2.0");
          assert.equal(message.id, ++count);
          if (count === 1) {
            assert.equal(message.result.protocolVersion, 1);
            send(2, "session/new", { cwd: root, mcpServers: [] });
          } else if (count === 2) {
            assert.equal(typeof message.result.sessionId, "string");
            send(3, "session/load", {});
          } else {
            assert.equal(message.error.code, -32601);
            child.stdin.end();
          }
        } catch (error) { clearTimeout(timeout); child.kill(); reject(error); }
      });
      send(1, "initialize", { protocolVersion: 1 });
    });
  } finally { lines.close(); if (child.exitCode === null) child.kill(); }
});

// Exercise real approval plumbing through the exported ACP adapter.
for (const allow of [true, false]) await fixture(async root => {
  const harness = await createHarness({ workspace: root, provider: "openai", subagentProfiles: [],
    modelInstance: createMockLanguageModel({ streamEvents: [
      turn("edit", "apply_reviewed_replacement", { path: "a.txt", expectedDigest: "sha256:" + createHash("sha256").update("before\n").digest("hex"), oldText: "before", newText: "after" }), done
    ] }) });
  const adapter = await createHarnessClientAdapter(harness);
  let permissions = 0;
  try {
    const acp = createAcpConnection(adapter, { workspace: root, notify() {}, requestPermission: async () => {
      assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before\n");
      permissions++;
      return { outcome: { outcome: "selected", optionId: allow ? "allow_once" : "reject_once" } };
    } });
    const call = (id, method, params) => acp.handle({ jsonrpc: "2.0", id, method, params });
    assert.equal((await call(1, "session/new", { cwd: root, mcpServers: [] })).error.code, -32002);
    assert((await call(2, "initialize", { protocolVersion: 1 })).result);
    const session = await call(3, "session/new", { cwd: root, mcpServers: [] });
    const result = await call(4, "session/prompt", { sessionId: session.result.sessionId, prompt: [{ type: "text", text: "Edit a.txt" }] });
    if (allow) assert.equal(result.result?.stopReason, "end_turn", JSON.stringify(result));
    else assert.equal(result.error?.message, "EXECUTION_FAILED");
    assert.equal(permissions, 1);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), allow ? "after\n" : "before\n");
    assert.equal(harness.workspace.mutationAudit().length, allow ? 1 : 0);
  } finally { adapter.close(); await harness.close(); }
});

// A rejected candidate is recovered with fresh read evidence; restart retains
// the exact approval payload, and intervening host edits must remain untouched.
for (const drift of [false, true]) await fixture(async root => {
  let harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel({ streamEvents: [
    turn("candidate", "apply_reviewed_edits", { changes: [{ path: "a.txt", content: "after\n" }] }),
    turn("read", "read_file", { path: "a.txt" }),
    turn("retry", "apply_reviewed_edits", { retryToolCallId: "candidate" }), done
  ] }) });
  try {
    const pending = await runHarness(harness, { messages: [...history, user("Repair a.txt")], toolExecution: { validationErrorMode: "tool-result" } });
    assert.equal(pending.status, "waiting_approval");
    assert(pending.toolResults.some(result => result.isError));
    const payload = JSON.parse(pending.state.pendingApprovals[0].arguments);
    assert.equal(payload.changes[0].content, "after\n");
    assert.match(payload.changes[0].expectedDigest, /^sha256:/);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before\n");
    await harness.close();
    harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel({ streamEvents: [done] }) });
    const saved = await harness.store.load(pending.state.runId, pending.state.scope);
    assert(saved);
    assert.equal(saved.pendingApprovals[0].arguments, pending.state.pendingApprovals[0].arguments);
    if (drift) await writeFile(path.join(root, "a.txt"), "external\n");
    const result = await runHarness(harness, { state: saved }, { resolveApprovals: approve }).catch(error => error);
    if (!drift) assert.equal(result.status, "completed");
    else assert(result instanceof Error || result.toolResults.some(receipt => receipt.isError));
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), drift ? "external\n" : "after\n");
  } finally { await harness.close(); }
});

// Real durable checkpoint state, reviewed restore, reopen and idempotent replay.
await fixture(async root => {
  const workspace = await Workspace.open(root);
  const options = { workspace: root, stateDirectory: path.join(root, ".state"), scope: { tenantId: "local", namespace: "installed-release" } };
  let sessions = await openCliSessionStore(options);
  let checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
  try {
    const session = await sessions.create({ initialRun: { runId: "checkpoint", provider: "test", model: "test", status: "completed" } });
    const captured = await checkpoints.capture({ sessionId: session.sessionId, turnId: session.runs[0].turnId, paths: ["a.txt"] });
    await writeFile(path.join(root, "a.txt"), "after\n");
    const prepared = await checkpoints.prepareRestore(captured.id, { "a.txt": (await workspace.readFile("a.txt")).digest });
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "after\n");
    checkpoints.close(); sessions.close();
    sessions = await openCliSessionStore(options);
    checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
    await assert.rejects(checkpoints.applyRestore(prepared.operation.id, "wrong-proposal"));
    const complete = await checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId);
    assert.equal(complete.stage, "completed");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before\n");
    assert.deepEqual(await checkpoints.applyRestore(complete.id, complete.proposalId), complete);
    assert.equal((await sessions.get(complete.forkSessionId)).parentSessionId, session.sessionId);
    assert.equal((await sessions.list()).filter(s => s.parentSessionId === session.sessionId).length, 1);
    const stale = await checkpoints.prepareRestore(captured.id, { "a.txt": (await workspace.readFile("a.txt")).digest });
    await writeFile(path.join(root, "a.txt"), "external\n");
    await assert.rejects(checkpoints.applyRestore(stale.operation.id, stale.operation.proposalId));
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "external\n");
  } finally { checkpoints.close(); sessions.close(); }
});

// Simulated OCI process adapter; snapshot, approval, persistence and import are
// real. This supplements, and never substitutes for, the enforced Docker gate.
const ociRuntimeAdapter = {
  async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference,
    imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
  async run() { throw new Error("unexpected process execution"); },
  async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
};
for (const allow of [true, false]) await fixture(async root => {
  const config = { workspace: root, provider: "openai", executionBackend: "oci", ociRuntimeAdapter };
  let harness = await createHarness({ ...config, modelInstance: createMockLanguageModel({ streamEvents: [
    turn("inspect", "inspect_environment_patch", {}), turn("import", "apply_environment_patch", {})
  ] }) });
  try {
    const session = await harness.executionEnvironment.acquire({ runId: "installed-import", scope: harness.config.scope });
    await writeFile(path.join(session.workspace.root, "a.txt"), "after\n");
    await session.release?.({ status: "waiting_approval" });
    const pending = await runHarness(harness, { runId: "installed-import", scope: harness.config.scope, prompt: "Inspect and import" }, { terminalReceiptTools: ["apply_environment_patch"] });
    assert.equal(pending.status, "waiting_approval");
    assert.match(JSON.parse(pending.state.pendingApprovals[0].arguments).patchId, /^sha256:/);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before\n");
    await harness.close();
    harness = await createHarness({ ...config, modelInstance: createMockLanguageModel({ streamEvents: [done] }) });
    const saved = await harness.store.load(pending.state.runId, pending.state.scope);
    assert(saved);
    const completed = await runHarness(harness, { state: saved }, { terminalReceiptTools: ["apply_environment_patch"],
      resolveApprovals: async approvals => (await approve(approvals)).map(a => ({ ...a, approve: allow })) });
    if (allow) assert.equal(completed.status, "completed");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), allow ? "after\n" : "before\n");
  } finally { await harness.close(); }
});
await fixture(async root => {
  let executions = 0;
  const runtime = { ...ociRuntimeAdapter, async run(request) {
    executions++;
    assert.deepEqual(request.command, ["bun", "test"]);
    await writeFile(path.join(request.snapshotRoot, "child-generated.txt"), "isolated\n");
    return { command: request.command, exitCode: 0, stdout: "", stderr: "", timedOut: false,
      cancelled: false, outputLimitExceeded: false, workspacePublished: true, workspaceExported: false };
  } };
  const config = { workspace: root, provider: "openai", executionBackend: "oci", ociRuntimeAdapter: runtime, ociAllowedCommands: ["bun"],
    subagentProfiles: ["implementer"],
    modelInstance: createMockLanguageModel({ streamEvents: [turn("delegate", "delegate_implementer", { prompt: "Run the check" }), done] }),
    subagentModels: { implementer: createMockLanguageModel({ responses: [
      { messages: [{ role: "assistant", parts: [turn("check", "run_environment_command", { command: "bun", args: ["test"] })[0]] }], finishReason: "tool-calls" },
      { messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], text: "done", finishReason: "stop" }
    ] }) }
  };
  let harness = await createHarness(config);
  try {
    const pending = await runHarness(harness, { runId: "installed-delegation", scope: harness.config.scope, prompt: "Delegate the check" });
    assert.equal(pending.status, "waiting_approval");
    assert.equal(pending.state.pendingApprovals[0].kind, "subagent");
    assert.equal(executions, 0);
    await harness.close();
    harness = await createHarness(config);
    const saved = await harness.store.load(pending.state.runId, pending.state.scope);
    assert(saved);
    const result = await runHarness(harness, { state: saved, approvals: await approve(saved.pendingApprovals) });
    assert.equal(executions, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.state.error?.message, "OCI_CHILD_DELIVERY_PENDING");
    assert.equal((await harness.store.load(result.state.runId, result.state.scope)).status, "failed");
    await assert.rejects(readFile(path.join(root, "child-generated.txt")));
  } finally { await harness.close(); }
});
console.log("INSTALLED_RELEASE_CONTRACTS_OK: compaction, ACP approval/refusal, edit recovery/restart, checkpoints, OCI resume/import/delegation");
