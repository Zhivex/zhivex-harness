import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHarness } from "@zhivex-ai/harness/engine";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { attachRuntime, type WebRuntime } from "../src/runtime.js";
import { startInteractiveWebRuntime } from "../src/interactive-startup.js";

for (const interactive of [false, true]) test(`real exclusive restart preserves ${interactive ? "unlimited" : "legacy bounded"} pending approval and its fingerprint`, async () => {
  const root = await mkdtemp("/tmp/web-startup-engine-");
  const workspace = root + "/repo"; await mkdir(workspace);
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "check", name: "run_check", input: { check: "test", expectedScript: "node -e 'process.exit(0)'" } } }, { type: "finish", finishReason: "tool-calls" }],
    [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }],
  ] });
  await Bun.write(workspace + "/package.json", JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
  const create = async (mode: boolean) => ({ secrets: [] as readonly string[], harness: await createHarness({
    workspace, provider: "openai", modelInstance: model, subagentProfiles: [], allowedChecks: ["test"], storeBackend: "sqlite",
    ...(mode ? { unlimitedSteps: true, unlimitedToolCalls: true, unlimitedTokens: true, unlimitedDuration: true } : {}),
  }) });
  const attach = (configured: Awaited<ReturnType<typeof create>>) => attachRuntime(configured.harness, root + "/socket", false);
  let runtime: WebRuntime | undefined;
  try {
    const initial = await create(interactive); runtime = await attach(initial);
    const created = await runtime.command({ method: "session.create", idempotencyKey: "create" });
    if (!created.ok || created.data.kind !== "session") throw Error("fixture create failed");
    const session = created.data.session;
    const started = await runtime.command({ method: "run.start", sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: "start", prompt: "Run the test then finish" });
    if (!started.ok || started.data.kind !== "run") throw Error("fixture start failed");
    expect(started.data.run.status).toBe("waiting_approval");
    const before = await initial.harness.store.load(started.data.run.runId, initial.harness.config.scope);
    await runtime.close(); runtime = undefined;
    const reopened = await startInteractiveWebRuntime(create, attach); runtime = reopened.runtime;
    expect(reopened.interactive).toBe(interactive);
    const receipt = await runtime.command({ method: "run.get", sessionId: session.sessionId, runId: started.data.run.runId });
    if (!receipt.ok || receipt.data.kind !== "run") throw Error("fixture reload failed");
    expect(before).toBeDefined(); expect(receipt.data.run.revision).toBe(before!.revision!);
    expect(receipt.data.run.approvals).toEqual(started.data.run.approvals);
    const review = await runtime.review("fixture", session.sessionId, started.data.run.runId);
    const resumed = await runtime.decide("fixture", review.ticketId, true);
    expect(resumed.ok).toBe(true);
    if (resumed.ok && resumed.data.kind === "run") expect(resumed.data.run.status).toBe("completed");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
