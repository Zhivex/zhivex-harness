import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createQwen } from "@zhivex-ai/qwen";
import { createHarness } from "../src/runtime/harness.js";
import { createHarnessClientAdapter } from "../src/client/adapter.js";
import { harnessErrorDocument, normalizeHarnessError } from "../src/runtime/errors.js";
import { streamEventDocument } from "../src/client/stream.js";
import { cliRunEventDocumentSchema } from "../src/client/json-contracts.js";

const diagnostic = { provider: "qwen", transport: "responses", diagnosticCode: "QWEN_SSE_EVENT_INVALID", reason: "invalid_json", retryable: false } as const;
const failure = () => Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), diagnostic, { name: "QwenStreamEventError", cause: new SyntaxError("PRIVATE_PARSER_CAUSE") });

test("preserves sanitized Qwen stream diagnostics through error wrappers", () => {
  const error = new Error("PRIVATE_WRAPPER_DETAIL", { cause: failure() });
  expect(normalizeHarnessError(error)).toMatchObject({ category: "provider", retryable: false });
  const document = harnessErrorDocument(error);
  expect(document.error).toMatchObject({ category: "provider", retryable: false, providerDiagnostic: diagnostic });
  expect(JSON.stringify(document)).not.toContain("PRIVATE");
});

test("projects safe stream-event diagnostics without raw provider contents", () => {
  const document = streamEventDocument({ type: "error", error: failure() });
  expect(document).toMatchObject({ error: "Provider stream failed.", providerDiagnostic: diagnostic });
  const parsed = cliRunEventDocumentSchema.parse(document);
  expect(parsed).toMatchObject({ type: "error", providerDiagnostic: diagnostic });
  expect(JSON.stringify(document)).not.toContain("PRIVATE");
});

test("does not expose unknown or mismatched structured fields", () => {
  for (const extra of [{ provider: "other" }, { transport: "PRIVATE" }, { reason: "PRIVATE" }, { diagnosticCode: "PRIVATE" }]) {
    const error = Object.assign(failure(), extra);
    expect(harnessErrorDocument(error).error.providerDiagnostic).toBeUndefined();
    const parsed = cliRunEventDocumentSchema.parse(streamEventDocument({ type: "error", error }));
    if (parsed.type !== "error") throw new Error("fixture event type");
    expect(parsed.providerDiagnostic).toBeUndefined();
  }
  const cyclic = new Error("PRIVATE"); cyclic.cause = cyclic;
  expect(harnessErrorDocument(cyclic).error.providerDiagnostic).toBeUndefined();
});

test("client failure and persisted run lookup retain safe diagnostics using installed Qwen", async () => {
  const workspace = await mkdtemp(`${tmpdir()}/qwen-stream-diagnostics-`);
  const model = createQwen({ apiKey: "offline-fixture", fetch: Object.assign(async () => new Response('data: {PRIVATE_PROVIDER_DETAIL\n\n'), { preconnect() {} }) as typeof fetch })("deepseek-v4.1-flash");
  const harness = await createHarness({ workspace, provider: "qwen", model: "deepseek-v4.1-flash", modelInstance: model, subagentProfiles: [] });
  const adapter = await createHarnessClientAdapter(harness);
  try {
    const hello = adapter.negotiate([1]); if (!hello.ok) throw new Error("fixture negotiation");
    let index = 0;
    const dispatch = (command: Record<string, unknown>) => adapter.dispatch({ protocolVersion: 1, connectionId: hello.connectionId, requestId: `fixture-${++index}`, command: { projectId: hello.projectId, ...command } });
    const created = await dispatch({ method: "session.create", idempotencyKey: "create" });
    if (!created.ok || created.data.kind !== "session") throw new Error("fixture session");
    const session = created.data.session;
    const started = await dispatch({ method: "run.start", sessionId: session.sessionId, expectedRevision: session.revision, prompt: "offline-fixture", idempotencyKey: "start" });
    expect(started).toMatchObject({ ok: false, error: { code: "EXECUTION_FAILED", providerDiagnostic: diagnostic } });
    const current = await dispatch({ method: "session.get", sessionId: session.sessionId });
    if (!current.ok || current.data.kind !== "session") throw new Error("fixture session lookup");
    const runId = current.data.session.runs.at(-1)!.runId;
    const result = await dispatch({ method: "run.get", sessionId: session.sessionId, runId });
    expect(result).toMatchObject({ ok: true, data: { kind: "run", run: { status: "failed", output: "", error: { category: "provider", providerDiagnostic: diagnostic } } } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(harness.workspace.mutationAudit()).toEqual([]);
    expect(await harness.store.listToolCalls?.(runId, harness.config.scope)).toEqual([]);
  } finally { await adapter.close(); await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});
