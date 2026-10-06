import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { emptyLimitSettings } from "../src/limit-settings.js";
import { WebLimitStore } from "../src/limit-store.js";

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
    expect(await reloaded.admit()).toEqual({ origin: "task", settings: task });
    expect((await store.read()).task).toBeNull();
    expect(await store.admit()).toEqual({ origin: "project", settings: project });
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
