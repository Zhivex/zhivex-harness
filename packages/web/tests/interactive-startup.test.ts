import { expect, test } from "bun:test";
import type { ZhivexHarness } from "@zhivex-ai/harness/engine";
import { resolveHarnessConfig } from "@zhivex-ai/harness/engine";
import { startInteractiveWebRuntime } from "../src/interactive-startup.js";
import type { WebRuntime } from "../src/runtime.js";

const original = resolveHarnessConfig({ workspace: "/tmp/atlas", stateDirectory: "/tmp/atlas-state" });
const next = resolveHarnessConfig({ ...original, unlimitedSteps: true, unlimitedToolCalls: true, unlimitedTokens: true, unlimitedDuration: true });
function fixture(states: Array<{ status: string; saved?: unknown }>, failure?: "list" | "owner" | "load") {
  const log: string[] = [];
  const create = async (interactive: boolean) => ({ secrets: [] as readonly string[], harness: {
    config: interactive ? next : original,
    store: {
      async list() { return { items: states.map((state, i) => ({ status: state.status, runId: String(i) })) }; },
      async load(id: string) { if (failure === "load") throw Error("IO"); return { metadata: { zhivexHarnessResume: states[Number(id)]?.saved } }; },
    },
    async close() { log.push(`dispose:${interactive}`); },
  } as unknown as ZhivexHarness });
  const attach = async (configured: Awaited<ReturnType<typeof create>>) => {
    const mode = configured.harness.config === next;
    log.push(`attach:${mode}`);
    if (failure === "owner") throw Error("LOCAL_SERVICE_OWNER_ALIVE");
    return {
      async command() { if (failure === "list") throw Error("IO"); return { ok: true, data: { kind: "sessions", sessions: [{ runs: states.map((state, i) => ({ runId: String(i), status: state.status })) }] } }; },
      async limits() { return { legacyPending: false }; },
      async close() { log.push(`close:${mode}`); },
    } as unknown as WebRuntime;
  };
  return { log, create, attach };
}
test("new or completed/cancelled tasks adopt interactive defaults only after exclusive readonly inspection", async () => {
  for (const states of [[], [{ status: "completed" }], [{ status: "cancelled" }]]) {
    const f = fixture(states); const result = await startInteractiveWebRuntime(f.create, f.attach);
    expect(result.interactive).toBe(true); expect(f.log).toEqual(["attach:false", "close:false", "attach:true"]);
  }
});
test("pending and approval legacy tasks keep exact original policy and require explicit restart", async () => {
  for (const status of ["running", "waiting_approval", "interrupted", "unknown"]) {
    const f = fixture([{ status, saved: { schemaVersion: 1, config: original } }]);
    const result = await startInteractiveWebRuntime(f.create, f.attach);
    expect(result.interactive).toBe(false); expect((await result.runtime.limits()).legacyPending).toBe(true);
    expect(f.log).toEqual(["attach:false", "dispose:true"]);
  }
});
test("restart recognizes every pending task's complete canonical configuration without changing policy", async () => {
  const f = fixture([{ status: "waiting_approval", saved: { schemaVersion: 1, config: next } }]);
  const result = await startInteractiveWebRuntime(f.create, f.attach);
  expect(result.interactive).toBe(true); expect(f.log).toEqual(["attach:false", "close:false", "attach:true"]);
});
test("mixed, missing, malformed and explicit changed configuration fail closed", async () => {
  for (const saved of [undefined, [], "bad", { schemaVersion: 2, config: next }, { schemaVersion: 1, config: { ...next, model: "other" } },
    { schemaVersion: 1, config: { ...next, workspace: "/tmp/other" } }, { schemaVersion: 1, config: { ...next, timeoutMs: 1234 } }]) {
    const f = fixture([{ status: "running", saved }]);
    expect((await startInteractiveWebRuntime(f.create, f.attach)).interactive).toBe(false);
    expect(f.log).not.toContain("close:false"); expect(f.log).not.toContain("attach:true");
  }
  const f = fixture([{ status: "running", saved: { schemaVersion: 1, config: next } }, { status: "waiting_approval", saved: { schemaVersion: 1, config: original } }]);
  expect((await startInteractiveWebRuntime(f.create, f.attach)).interactive).toBe(false);
});
test("failed inspection/loads preserve original; another live owner cannot be replaced", async () => {
  for (const failure of ["list", "load"] as const) {
    const f = fixture([{ status: "waiting_approval", saved: { schemaVersion: 1, config: next } }], failure);
    expect((await startInteractiveWebRuntime(f.create, f.attach)).interactive).toBe(false);
    expect(f.log).not.toContain("close:false");
  }
  const f = fixture([], "owner");
  await expect(startInteractiveWebRuntime(f.create, f.attach)).rejects.toThrow("LOCAL_SERVICE_OWNER_ALIVE");
  expect(f.log).toEqual(["attach:false", "dispose:false"]);
});

test("an unfinished run hidden from the browser list or an incomplete store page never enables new defaults", async () => {
  const f = fixture([{ status: "waiting_approval", saved: { schemaVersion: 1, config: original } }]);
  const attach = async (configured: Awaited<ReturnType<typeof f.create>>) => {
    const runtime = await f.attach(configured);
    runtime.command = async () => ({ ok: true, data: { kind: "sessions", sessions: [] } }) as never;
    return runtime;
  };
  expect((await startInteractiveWebRuntime(f.create, attach)).interactive).toBe(false);
  const cyclic = async (interactive: boolean) => {
    const configured = await f.create(interactive);
    configured.harness.store.list = async () => ({ items: [], nextCursor: "same" });
    return configured;
  };
  expect((await startInteractiveWebRuntime(cyclic, f.attach)).interactive).toBe(false);
});
