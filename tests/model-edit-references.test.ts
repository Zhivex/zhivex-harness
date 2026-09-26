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
