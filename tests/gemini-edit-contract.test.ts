import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { tool } from "@zhivex-ai/agents";
import { createProviderModel } from "../src/runtime/config.js";
import { editProposalInputSchema } from "../src/workspace/edit-contracts.js";
import { createEditProposal } from "../src/workspace/edit-contracts.js";

for (const existing of [false, true]) test(`Gemini 3.7 streamed ${existing ? "update" : "creation"} preserves schema, signed continuation and durable approval`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-gemini-contract-"));
  const originalFetch = globalThis.fetch;
  const before = "before\n";
  const changes = [{ path: "target.txt", content: "after\n", expectedDigest: existing ? `sha256:${createHash("sha256").update(before).digest("hex")}` : null }];
  const proposal = createEditProposal({ changes });
  const bodies: any[] = [];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const index = bodies.length - 1;
    const part = index === 0 ? { functionCall: { id: "gemini-propose", name: "propose_edits", args: { changes } }, thoughtSignature: "signature-propose" }
      : index === 1 ? { functionCall: { id: "gemini-apply", name: "apply_patch", args: { proposalId: proposal.proposalId, changes } }, thoughtSignature: "signature-apply" }
      : { text: "done" };
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`);
  }, { preconnect: originalFetch.preconnect });
  const options = { provider: "gemini", model: "gemini-3.7-flash", workspace: root, env: { GEMINI_API_KEY: "synthetic-gemini-key" }, projectContext: false };
  try {
    if (existing) await writeFile(path.join(root, "target.txt"), before);
    harness = await createHarness(options);
    const waiting = await runHarness(harness, { prompt: "Propose and apply the edit" });
    expect(waiting.status).toBe("waiting_approval");
    expect(await readFile(path.join(root, "target.txt"), "utf8").catch(() => null)).toBe(existing ? before : null);
    const schema = bodies[0].tools.flatMap((t: any) => t.functionDeclarations ?? []).find((t: any) => t.name === "apply_patch").parameters;
    expect(schema.required).toContain("proposalId");
    const changeSchema = schema.properties.changes.items;
    expect(changeSchema.required).toContain("expectedDigest");
    expect(changeSchema.properties.expectedDigest.anyOf).toContainEqual({ type: "null" });
    expect(changeSchema.properties.expectedDigest.anyOf).toContainEqual(expect.objectContaining({ type: "string", pattern: "^sha256:[a-f0-9]{64}$" }));
    const parts = bodies[1].contents.flatMap((m: any) => m.parts);
    expect(parts).toContainEqual(expect.objectContaining({ thoughtSignature: "signature-propose", functionCall: expect.objectContaining({ id: "gemini-propose" }) }));
    expect(parts).toContainEqual(expect.objectContaining({ functionResponse: expect.objectContaining({ id: "gemini-propose", name: "propose_edits" }) }));
    const runId = waiting.state.runId;
    await harness.close(); harness = await createHarness(options);
    const state = await harness.store.load(runId, harness.config.scope); expect(state).not.toBeNull();
    const result = await runHarness(harness, { state: state!, approvals: state!.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
    expect(result.status).toBe("completed");
    expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(result.toolResults.filter(t => t.toolName === "apply_patch")).toHaveLength(1);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(bodies[2].contents.flatMap((m: any) => m.parts)).toContainEqual(expect.objectContaining({ thoughtSignature: "signature-apply" }));
  } finally { globalThis.fetch = originalFetch; await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const badChange of [
  { path: "target.txt", content: "after\n" },
  { path: "target.txt", content: "after\n", expectedDigest: "invented" }
]) test("Gemini missing or invalid digest cannot be inferred, approved or executed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-gemini-invalid-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  globalThis.fetch = Object.assign(async () => {
    const part = calls++ === 0 ? { functionCall: { id: "invalid-edit", name: "apply_reviewed_edits", args: { changes: [badChange] } } } : { text: "Unable to edit" };
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }] })}\n\n`);
  }, { preconnect: originalFetch.preconnect });
  try {
    harness = await createHarness({ provider: "gemini", model: "gemini-3.7-flash", workspace: root, env: { GEMINI_API_KEY: "synthetic-key" }, projectContext: false });
    const result = await runHarness(harness, { prompt: "Create a file" });
    expect(result.state.pendingApprovals).toHaveLength(0);
    expect(result.toolResults.some(t => t.toolName === "apply_reviewed_edits" && t.isError)).toBe(true);
    expect(await readFile(path.join(root, "target.txt"), "utf8").catch(() => null)).toBeNull();
  } finally { globalThis.fetch = originalFetch; await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Gemini nonstreaming schema and continuation retain explicit null and matching receipts", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  const changes = [{ path: "new.txt", expectedDigest: null, content: "new\n" }];
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "generate-signature", functionCall: { id: "generate-call", name: "propose_edits", args: { changes } } }] }, finishReason: "STOP" }] });
  }, { preconnect: originalFetch.preconnect });
  try {
    const model = createProviderModel({ provider: "gemini", model: "gemini-3.7-flash" }, { GEMINI_API_KEY: "synthetic-key" });
    const tools = { propose_edits: tool({ name: "propose_edits", description: "Propose reviewed changes", schema: editProposalInputSchema, execute: async () => ({ ok: true }) }) };
    const result = await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Create the file" }] }], tools });
    const assistant = result.messages![0]!;
    expect(assistant.parts).toContainEqual({ type: "tool-call", toolCall: { id: "generate-call", name: "propose_edits", input: { changes }, providerMetadata: { geminiThoughtSignature: "generate-signature" } } });
    await model.generate({ messages: [assistant, { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "generate-call", toolName: "propose_edits", output: { ok: true }, isError: false } }] }], tools });
    expect(bodies[1].contents[0].parts[0].functionCall.args.changes[0]).toHaveProperty("expectedDigest", null);
    expect(bodies[1].contents[0].parts[0].thoughtSignature).toBe("generate-signature");
    expect(bodies[1].contents[1].parts[0].functionResponse.id).toBe("generate-call");
    expect(bodies[0].tools[0].functionDeclarations[0].parameters.properties.changes.items.required).toContain("expectedDigest");
  } finally { globalThis.fetch = originalFetch; }
});
