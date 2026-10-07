import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { emptyLimitSettings } from "../src/limit-settings.js";
import { WebLimitStore } from "../src/limit-store.js";
import type { RunLimits } from "../src/limit-observer.js";
const admission = (runId: string) => (snapshot: Pick<RunLimits, "settings" | "origin">): RunLimits => ({
  ...snapshot, runId, sessionId: "session", startedAt: 0, status: "created", notices: [], cancellationRequested: false,
  consumption: { costUsd: null, tokens: 0, steps: 0, toolCalls: 0, durationMinutes: 0 },
  reportedUsage: { inputTokens: 0, outputTokens: 0, complete: true, lastStep: 0 }, toolReceipts: [], pricing: null,
});

async function fixture(job: (store: WebLimitStore, directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp("/tmp/web-limit-test-"));
  try { await job(new WebLimitStore(directory, ["atlas", { tenantId: "test" }]), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test("workspace preferences persist, task override is consumed only on admission, project remains", async () => {
  await fixture(async (store, directory) => {
    const project = { ...emptyLimitSettings(), steps: { value: 3, action: "notify" as const } };
    const task = { ...emptyLimitSettings(), tokens: { value: 100, action: "stop" as const } };
    const saved = await store.save("project", project, 0);
    await store.save("task", task, saved.revision);
    const reloaded = new WebLimitStore(directory, ["atlas", { tenantId: "test" }]);
    expect((await reloaded.read()).task).toEqual(task);
    const run = await reloaded.admit(admission("run_task"));
    expect(run).toMatchObject({ origin: "task", settings: task });
    expect((await store.read()).task).toBeNull();
    // The atomic document supplies the snapshot before any per-run write/event.
    expect(await reloaded.readRun("run_task")).toEqual(run);
    const next = await store.admit(admission("run_project"));
    expect(next).toMatchObject({ origin: "project", settings: project });
    expect(await reloaded.readRun("run_task")).toEqual(run);
    expect(await reloaded.readRun("run_project")).toEqual(next);
    expect((await new WebLimitStore(directory, ["beacon", { tenantId: "test" }]).read()).project).toEqual(emptyLimitSettings());
  });
});
test("concurrent settings updates require the exact revision and reject invalid data", async () => {
  await fixture(async store => {
    const results = await Promise.allSettled([store.save("task", emptyLimitSettings(), 0), store.save("project", emptyLimitSettings(), 0)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(store.save("project", { ...emptyLimitSettings(), steps: { value: -1, action: "stop" } }, 1)).rejects.toThrow("WEB_LIMIT_SETTINGS_INVALID");
  });
});
test("legacy preference documents upgrade only on write and newer run checkpoints survive another admission", async () => {
  await fixture(async store => {
    const legacy = { schemaVersion: 1 as const, revision: 7, project: emptyLimitSettings(), task: emptyLimitSettings() };
    await writeFile(store.filename, JSON.stringify(legacy), { mode: 0o600 });
    expect(await store.read()).toEqual(legacy);
    expect(JSON.parse(await readFile(store.filename, "utf8"))).toEqual(legacy);
    const first = await store.admit(admission("run_first"));
    const checkpoint = { ...first, status: "waiting_approval", consumption: { ...first.consumption, tokens: 9 } };
    await store.saveRun(checkpoint);
    await store.save("task", emptyLimitSettings(), 8);
    await store.admit(admission("run_second"));
    expect(await store.readRun("run_first")).toEqual(checkpoint);
    expect((await store.read()).revision).toBe(10);
    expect((await store.read()).schemaVersion).toBe(1); // Browser contract stays unchanged.
  });
});
test("corrupt or unsafe run files reject instead of using the admission fallback", async () => {
  await fixture(async store => {
    await store.admit(admission("run_corrupt"));
    const filename = store.filename.replace(/\.json$/, "-run_corrupt.json");
    await writeFile(filename, "not json", { mode: 0o600 });
    await expect(store.readRun("run_corrupt")).rejects.toThrow();
    await writeFile(filename, JSON.stringify(admission("run_corrupt")({ settings: emptyLimitSettings(), origin: "default" })));
    await chmod(filename, 0o644);
    await expect(store.readRun("run_corrupt")).rejects.toThrow("WEB_LIMIT_STORAGE_UNSAFE");
  });
});
test("preference symlinks and hardlinks fail closed and never overwrite another file", async () => {
  await fixture(async (store, directory) => {
    const outside = directory + "/sentinel";
    await writeFile(outside, "untouched", { mode: 0o600 });
    await symlink(outside, store.filename);
    await expect(store.save("task", emptyLimitSettings(), 0)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("untouched");
    await rm(store.filename);
    await link(outside, store.filename);
    await expect(store.read()).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
});
test("public permissions, malformed settings and symlink state directories are rejected", async () => {
  await fixture(async (store, directory) => {
    await store.save("task", emptyLimitSettings(), 0);
    await chmod(store.filename, 0o644);
    await expect(store.read()).rejects.toThrow("WEB_LIMIT_STORAGE_UNSAFE");
    await chmod(store.filename, 0o600);
    await writeFile(store.filename, '{"sandbox":false}');
    await expect(store.read()).rejects.toThrow("WEB_LIMIT_SETTINGS_INVALID");
    const indirect = directory + "/link";
    await symlink(directory, indirect);
    await expect(new WebLimitStore(indirect, "test").read()).rejects.toThrow("WEB_LIMIT_STORAGE_UNSAFE");
  });
});
