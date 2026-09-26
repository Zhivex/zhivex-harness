import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { serializeJsonValue, wrapLanguageModel, type ModelMessage, type ToolSet, type StreamToolCallEvent, type StreamFinishEvent } from "@zhivex-ai/core";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import type { HarnessExecutionSession, HarnessOciRuntimeAdapter } from "../src/execution/execution-environment.js";

const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const turn = (id: string, name: string, input: unknown) => [{ type: "tool-call" as const, toolCall: { id, name, input: serializeJsonValue(input) } }, { type: "finish" as const, finishReason: "tool-calls" as const, usage }] satisfies [StreamToolCallEvent, StreamFinishEvent];
const done = [{ type: "text-delta" as const, textDelta: "done" }, { type: "finish" as const, finishReason: "stop" as const, usage }];

for (const scenario of ["replacement", "edits", "create", "missing-read", "drift", "resume"] as const) test(`model edit references: ${scenario}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-edit-refs-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "before\n");
    const editing = scenario === "replacement" ? "apply_reviewed_replacement" : "apply_reviewed_edits";
    const streams = [ ...(scenario === "missing-read" || scenario === "create" ? [] : [turn("read", "read_files", { files: [{ path: "a.txt" }] })]),
      turn("edit", editing, scenario === "replacement" ? { path: "a.txt", oldText: "before", newText: "after" } : { changes: [{ path: scenario === "create" ? "new.txt" : "a.txt", content: "after\n", ...(scenario === "create" ? { create: true } : {}) }] }), done ];
    const model = wrapLanguageModel(createMockLanguageModel({ streamEvents: streams }), [{ wrapStream: async (context, next) => {
      const definition = context.input.tools?.[editing];
      expect(definition && "schema" in definition).toBe(true);
      if (definition && "schema" in definition) expect(JSON.stringify(definition.schema)).not.toContain("expectedDigest");
      return next();
    } }]);
    const store = createInMemoryAgentRunStore();
    harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model, store, maxSteps: 6 });
    const output = await runHarness(harness, { runId: "edit-refs", prompt: "Repair.", toolExecution: { stopOnError: false, validationErrorMode: "tool-result" } });
    if (scenario === "missing-read") {
      expect(output.status).toBe("completed");
      expect(output.toolResults.some(item => item.error?.code === "TOOL_INPUT_VALIDATION_ERROR")).toBe(true);
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n"); return;
    }
    expect(output.status).toBe("waiting_approval");
    const approval = output.state.pendingApprovals[0]!;
    const args = JSON.parse(approval.arguments);
    expect(scenario === "replacement" ? args.expectedDigest : args.changes[0].expectedDigest).toEqual(scenario === "create" ? null : expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n");
    if (scenario === "drift") await writeFile(path.join(root, "a.txt"), "external\n");
    if (scenario === "resume") { await harness.close(); harness = await createHarness({ workspace: root, provider: "openai", modelInstance: createMockLanguageModel({ streamEvents: [done] }), store }); }
    const result = await runHarness(harness, { state: (await store.load("edit-refs"))! }, { resolveApprovals: async pending => pending.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) }).catch(error => error);
    if (scenario === "drift") expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("external\n");
    else { expect(result.status).toBe("completed"); expect(await readFile(path.join(root, scenario === "create" ? "new.txt" : "a.txt"), "utf8")).toBe("after\n"); }
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const drift of [false, true]) test(`model import reference is durable before approval: drift=${drift}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-import-refs-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "before\n");
    const runtime: HarnessOciRuntimeAdapter = {
      async inspectImage(imageReference) { return { runtime: "docker", runtimeVersion: "fixture", imageReference, imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }; },
      async run() { throw new Error("unexpected execution"); }, async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
    };
    const store = createInMemoryAgentRunStore();
    harness = await createHarness({ workspace: root, executionBackend: "oci", provider: "openai", modelInstance: createMockLanguageModel({ streamEvents: [turn("inspect", "inspect_environment_patch", {}), turn("import", "apply_environment_patch", {})] }), store, ociRuntimeAdapter: runtime });
    const session = await harness.executionEnvironment!.acquire({ runId: "import-refs" }) as HarnessExecutionSession;
    await writeFile(path.join(session.workspace.root, "a.txt"), "after\n");
    await session.release?.({ status: "waiting_approval" });
    const output = await runHarness(harness, { runId: "import-refs", prompt: "Inspect then import." }, { terminalReceiptTools: ["apply_environment_patch"] });
    expect(output.status).toBe("waiting_approval");
    expect(JSON.parse(output.state.pendingApprovals[0]!.arguments).patchId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n");
    if (drift) await writeFile(path.join(session.workspace.root, "a.txt"), "changed\n");
    await harness.close();
    harness = await createHarness({ workspace: root, executionBackend: "oci", provider: "openai", modelInstance: createMockLanguageModel({ streamEvents: [done] }), store, ociRuntimeAdapter: runtime });
    const result = runHarness(harness, { state: (await store.load("import-refs"))! }, { terminalReceiptTools: ["apply_environment_patch"], resolveApprovals: async pending => pending.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
    if (drift) { await expect(result).rejects.toThrow("changed after review"); expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n"); }
    else { expect((await result).status).toBe("completed"); expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("after\n"); }
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test("generate preserves explicit references, isolates requests and respects tool availability", async () => {
  const { z } = await import("zod");
  const { createModelEditReferences } = await import("../src/runtime/model-edit-references.js");
  const { fileDigestSchema } = await import("../src/workspace/edit-contracts.js");
  const original = { name: "apply_environment_patch", schema: z.strictObject({ patchId: fileDigestSchema }), execute: async () => null };
  const verified = { name: "verify_and_apply_environment_patch", schema: z.strictObject({ patchId: fileDigestSchema, command: z.literal("bun"), args: z.array(z.string()) }), execute: async () => null };
  const reviewed = `sha256:${"a".repeat(64)}`, explicit = `sha256:${"b".repeat(64)}`;
  const middleware = createModelEditReferences({ apply_environment_patch: original, verify_and_apply_environment_patch: verified });
  const messages: ModelMessage[] = [ { role: "assistant" as const, parts: [turn("inspection", "inspect_environment_patch", {})[0]!] },
    { role: "tool" as const, parts: [{ type: "tool-result" as const, toolResult: { toolCallId: "inspection", toolName: "inspect_environment_patch", isError: false, output: { kind: "environment-patch", patchId: reviewed } } }] } ];
  let input: Record<string, unknown> = {};
  let name = "apply_environment_patch";
  const model = wrapLanguageModel({ ...createMockLanguageModel(), generate: async () => ({ message: { role: "assistant" as const, parts: [turn("import", name, input)[0]!] } }) }, [middleware]);
  const invoke = async (history: ModelMessage[] = messages, tools: ToolSet = { apply_environment_patch: original, verify_and_apply_environment_patch: verified }) => {
    const result = await model.generate({ messages: history, tools });
    const part = result.message!.parts[0]!;
    if (part.type !== "tool-call") throw new Error("missing call");
    return part.toolCall.input;
  };
  expect(await invoke()).toEqual({ patchId: reviewed });
  expect(await invoke([])).toEqual({});
  input = { patchId: explicit }; expect(await invoke()).toEqual({ patchId: explicit });
  input = {}; expect(await invoke(messages, {})).toEqual({});
  const override = { ...original, schema: z.strictObject({}) };
  expect(await invoke(messages, { apply_environment_patch: override })).toEqual({});
  name = "verify_and_apply_environment_patch"; input = { command: "bun", args: ["test"] };
  expect(await invoke()).toEqual({ command: "bun", args: ["test"], patchId: reviewed });
  expect(original.schema.safeParse({}).success).toBe(false);
  expect(await invoke([{ ...messages[1]!, role: "user" }])).toEqual({ command: "bun", args: ["test"] });
});

for (const drift of [false, true]) test(`delegated implementer binds references before promoted approval: drift=${drift}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-child-refs-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "before\n");
    const parent = createMockLanguageModel({ streamEvents: [turn("delegate", "delegate_implementer", { prompt: "Repair a.txt" }), done] });
    const child = wrapLanguageModel(createMockLanguageModel({ responses: [
      { messages: [{ role: "assistant", parts: [turn("read", "read_file", { path: "a.txt" })[0]] }], finishReason: "tool-calls", usage },
      { messages: [{ role: "assistant", parts: [turn("edit", "apply_reviewed_replacement", { path: "a.txt", oldText: "before", newText: "after" })[0]] }], finishReason: "tool-calls", usage },
      { text: "done", messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], finishReason: "stop", usage }
    ] }), [{ wrapGenerate: async (context, next) => {
      const tool = context.input.tools?.apply_reviewed_replacement;
      expect(tool && "schema" in tool && JSON.stringify(tool.schema).includes("expectedDigest")).toBe(false);
      return next();
    } }]);
    const store = createInMemoryAgentRunStore();
    harness = await createHarness({ workspace: root, provider: "openai", modelInstance: parent, subagentProfiles: ["implementer"], subagentModels: { implementer: child }, store });
    const waiting = await runHarness(harness, { prompt: "Delegate the repair", runId: "parent-edit-refs", scope: harness.config.scope });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.pendingApprovals[0]!.kind).toBe("subagent");
    const savedChild = await store.load(waiting.state.childRuns![0]!.runId, harness.config.scope);
    expect(JSON.parse(savedChild!.pendingApprovals[0]!.arguments).expectedDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n");
    if (drift) await writeFile(path.join(root, "a.txt"), "external\n");
    const result = await runHarness(harness, { state: waiting.state, approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) }).catch(() => undefined);
    if (drift) expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("external\n");
    else { expect(result?.status).toBe("completed"); expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("after\n"); }
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test("reference refreshes discard stale evidence and consume only matching read results", async () => {
  const { z } = await import("zod");
  const { createModelEditReferences } = await import("../src/runtime/model-edit-references.js");
  const { editChangesSchema, fileDigestSchema } = await import("../src/workspace/edit-contracts.js");
  const tools = {
    apply_reviewed_edits: { name: "apply_reviewed_edits", schema: z.strictObject({ changes: editChangesSchema }), execute: async () => null },
    apply_environment_patch: { name: "apply_environment_patch", schema: z.strictObject({ patchId: fileDigestSchema }), execute: async () => null }
  };
  const old = `sha256:${"a".repeat(64)}`, fresh = `sha256:${"b".repeat(64)}`;
  const call = (id: string, name: string, input: unknown): ModelMessage => ({ role: "assistant", parts: [turn(id, name, input)[0]] });
  const result = (id: string, name: string, output: unknown, isError = false): ModelMessage => ({ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: id, toolName: name, output: serializeJsonValue(output), isError } }] });
  const read = (id: string, file: string, digest = old): ModelMessage[] => [call(id, "read_file", { path: file }), result(id, "read_file", { path: file, digest })];
  const inspected: ModelMessage[] = [call("inspect1", "inspect_environment_patch", {}), result("inspect1", "inspect_environment_patch", { kind: "environment-patch", patchId: old })];
  const bind = async (messages: ModelMessage[], name = "apply_reviewed_edits", input: unknown = { changes: [{ path: "a.txt", content: "after" }] }) => {
    const model = wrapLanguageModel({ ...createMockLanguageModel(), generate: async () => ({ message: call("edit", name, input) }) }, [createModelEditReferences(tools)]);
    const output = (await model.generate({ messages, tools })).message!.parts[0]!;
    if (output.type !== "tool-call") throw new Error("missing call");
    return output.toolCall.input;
  };
  const unbound = { changes: [{ path: "a.txt", content: "after" }] };
  const bound = { changes: [{ path: "a.txt", content: "after", expectedDigest: fresh }] };
  const failedRead = [call("read2", "read_file", { path: "./a.txt" }), result("read2", "read_file", { message: "file missing" }, true)];
  expect(await bind([...read("read1", "a.txt"), ...failedRead])).toEqual(unbound);
  expect(await bind([...read("read1", "a.txt"), ...failedRead, ...read("read3", "a.txt", fresh)])).toEqual(bound);
  // Unrelated successful reads survive a failed refresh.
  expect(await bind([...read("b", "b.txt", fresh), ...failedRead], "apply_reviewed_edits", { changes: [{ path: "b.txt", content: "after" }] })).toEqual({ changes: [{ path: "b.txt", content: "after", expectedDigest: fresh }] });
  // A batch failure invalidates all requested aliases, but a subsequent read restores evidence.
  expect(await bind([...read("read1", "a.txt"), call("batch", "read_files", { files: [{ path: "./a.txt" }, { path: "missing.txt" }] }), result("batch", "read_files", {}, true)])).toEqual(unbound);
  expect(await bind([call("batch", "read_files", { files: [{ path: "./a.txt" }] }), result("batch", "read_files", { files: [{ path: "a.txt", digest: fresh }] })])).toEqual(bound);
  // Neither malformed refreshes nor missing results fall back to an older digest.
  expect(await bind([...read("read1", "a.txt"), call("read2", "read_file", { path: "a.txt" })])).toEqual(unbound);
  expect(await bind([...read("read1", "a.txt"), call("read2", "read_file", { path: "a.txt" }), result("read2", "read_file", { path: "a.txt", digest: "invalid" })])).toEqual(unbound);
  // A replayed result cannot roll evidence back; late results cannot undo a newer failed refresh.
  expect(await bind([...read("read1", "a.txt"), ...read("read2", "a.txt", fresh), result("read1", "read_file", { path: "a.txt", digest: old })])).toEqual(bound);
  expect(await bind([call("read1", "read_file", { path: "a.txt" }), ...failedRead, result("read1", "read_file", { path: "a.txt", digest: old })])).toEqual(unbound);
  expect(await bind([call("read1", "read_file", { path: "b.txt" }), result("read1", "read_file", { path: "a.txt", digest: old })])).toEqual(unbound);
  expect(await bind([result("orphan", "read_file", { path: "a.txt", digest: old })])).toEqual(unbound);
  expect(await bind([call("duplicate", "read_file", { path: "a.txt" }), call("duplicate", "read_file", { path: "a.txt" }), result("duplicate", "read_file", { path: "a.txt", digest: old })])).toEqual(unbound);
  const failedInspection = [call("inspect2", "inspect_environment_patch", {}), result("inspect2", "inspect_environment_patch", {}, true)];
  expect(await bind([...inspected, ...failedInspection], "apply_environment_patch", {})).toEqual({});
  expect(await bind([...inspected, ...failedInspection, result("inspect1", "inspect_environment_patch", { kind: "environment-patch", patchId: old })], "apply_environment_patch", {})).toEqual({});
  expect(await bind([...inspected, ...failedInspection, call("inspect3", "inspect_environment_patch", {}), result("inspect3", "inspect_environment_patch", { kind: "environment-patch", patchId: fresh })], "apply_environment_patch", {})).toEqual({ patchId: fresh });
  // Explicit caller references remain exact: middleware never repairs an approved value.
  expect(await bind([...inspected, ...failedInspection], "apply_environment_patch", { patchId: old })).toEqual({ patchId: old });
});

test("missing hidden digest guides a real run to reread and obtain an exact approved edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-reference-recovery-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "before\n");
    const observedErrors: string[] = [];
    const edit = { changes: [{ path: "a.txt", content: "after\n" }] };
    const model = wrapLanguageModel(createMockLanguageModel({ streamEvents: [
      turn("missing", "apply_reviewed_edits", edit),
      turn("refresh", "read_file", { path: "a.txt" }),
      turn("retry", "apply_reviewed_edits", edit), done
    ] }), [{ wrapStream: async (context, next) => {
      for (const message of context.input.messages) for (const part of message.parts) {
        if (part.type === "tool-result" && part.toolResult.error) observedErrors.push(part.toolResult.error.message);
      }
      return next();
    } }]);
    harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model, maxSteps: 6 });
    const waiting = await runHarness(harness, { prompt: "Repair a.txt", toolExecution: { stopOnError: false, validationErrorMode: "tool-result" } });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.pendingApprovals).toHaveLength(1);
    expect(observedErrors.some(message => message.includes("Call read_file or read_files") && message.includes("Omit expectedDigest"))).toBe(true);
    const failure = waiting.toolResults.find(result => result.error?.code === "TOOL_INPUT_VALIDATION_ERROR");
    expect(failure?.error?.message).toBe("Tool arguments do not match the input schema.");
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update("before\n").digest("hex")}`;
    expect(JSON.parse(waiting.state.pendingApprovals[0]!.arguments)).toEqual({ changes: [{ path: "a.txt", content: "after\n", expectedDigest: digest }] });
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n");
    const complete = await runHarness(harness, { state: waiting.state }, { resolveApprovals: async pending => pending.map(approval => ({ provider: approval.provider, approvalRequestId: approval.id, approve: true })) });
    expect(complete.status).toBe("completed");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("after\n");
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test("hidden patch validation receives provider-only inspection guidance, explicit references do not", async () => {
  const { z } = await import("zod");
  const { createModelEditReferences } = await import("../src/runtime/model-edit-references.js");
  const { fileDigestSchema } = await import("../src/workspace/edit-contracts.js");
  const tools = { apply_environment_patch: { name: "apply_environment_patch", schema: z.strictObject({ patchId: fileDigestSchema }), execute: async () => null } };
  for (const input of [{}, { patchId: "invalid" }]) {
    const history: ModelMessage[] = [
      { role: "assistant", parts: [turn("import", "apply_environment_patch", input)[0]] },
      { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "import", toolName: "apply_environment_patch", isError: true, error: { code: "TOOL_INPUT_VALIDATION_ERROR", message: "Invalid arguments", issues: [{ code: "invalid_type", path: ["patchId"] }] } } }] }
    ];
    const original = JSON.stringify(history);
    let observed = "";
    const model = wrapLanguageModel({ ...createMockLanguageModel(), generate: async request => { observed = JSON.stringify(request.messages); return { message: { role: "assistant", parts: [{ type: "text", text: "done" }] } }; } }, [createModelEditReferences(tools)]);
    await model.generate({ messages: history, tools });
    expect(observed.includes("Call inspect_environment_patch")).toBe(!("patchId" in input));
    expect(JSON.stringify(history)).toBe(original);
  }
});

test("malformed reads receive provider-only corrections and recover to an approved edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-read-recovery-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "before\nsecond\n");
    const observed: string[] = [];
    const model = wrapLanguageModel(createMockLanguageModel({ streamEvents: [
      turn("wrong-name", "read_file", { files: '[{"path":"a.txt"}]' }),
      turn("wrong-array", "read_files", { files: '[{"path":"a.txt"}]' }),
      turn("wrong-range", "read_files", { files: [{ path: "a.txt", startLine: 2, endLine: 1 }] }),
      turn("correct", "read_files", { files: [{ path: "a.txt", startLine: 1, endLine: 2 }] }),
      turn("edit", "apply_reviewed_replacement", { path: "a.txt", oldText: "before", newText: "after" }), done
    ] }), [{ wrapStream: async (context, next) => {
      for (const message of context.input.messages) for (const part of message.parts) {
        if (part.type === "tool-result" && part.toolResult.error) observed.push(part.toolResult.error.message);
      }
      return next();
    } }]);
    harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model, maxSteps: 8 });
    const waiting = await runHarness(harness, { prompt: "Replace before with after", toolExecution: { stopOnError: false, validationErrorMode: "tool-result" } });
    expect(waiting.status).toBe("waiting_approval");
    expect(observed.some(text => text.includes("reads ONE file") && text.includes("not a JSON-encoded string"))).toBe(true);
    expect(observed.some(text => text.includes("actual array of objects"))).toBe(true);
    expect(observed.some(text => text.includes("absolute, inclusive line numbers"))).toBe(true);
    expect(waiting.toolResults.filter(result => result.isError)).toHaveLength(3);
    expect(waiting.toolResults.filter(result => result.error?.code === "TOOL_INPUT_VALIDATION_ERROR")
      .every(result => result.error?.message === "Tool arguments do not match the input schema.")).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\nsecond\n");
    const complete = await runHarness(harness, { state: waiting.state }, { resolveApprovals: async approvals => approvals.map(approval => ({ provider: approval.provider, approvalRequestId: approval.id, approve: true })) });
    expect(complete.status).toBe("completed");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("after\nsecond\n");
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});
