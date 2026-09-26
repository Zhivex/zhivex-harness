import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverHarnessScopedContext, refreshHarnessScopedContext, validateHarnessScopedContext,
  type HarnessScopedContextState } from "../src/context/scoped-context.js";
import { MAX_HARNESS_CONTEXT_FILE_BYTES } from "../src/context/context-engineering.js";

const fixture = async (run: (workspace: { root: string }) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-scoped-refresh-"));
  try { await run({ root }); } finally { await rm(root, { recursive: true, force: true }); }
};

test("small scoped guidance is not limited by historical file or directory counts", () => fixture(async workspace => {
  let state: HarnessScopedContextState = { schemaVersion: 1, entries: [] };
  // More than 256 remembered absent ancestors and 32 actual guidance files.
  for (let index = 0; index < 257; index++) {
    const directory = `package-${index}`;
    await mkdir(path.join(workspace.root, directory));
    if (index < 33) await writeFile(path.join(workspace.root, directory, "AGENTS.md"), "Use Bun.");
    state.entries.push({ path: `${directory}/AGENTS.md`, digest: null, bytes: 0 });
  }
  state = (await refreshHarnessScopedContext(workspace, state)).state;
  expect((await validateHarnessScopedContext(workspace, state))).toHaveLength(33);
  await mkdir(path.join(workspace.root, "next"));
  await writeFile(path.join(workspace.root, "next/AGENTS.md"), "Run tests.");
  const discovered = await discoverHarnessScopedContext(workspace, { paths: ["next/code.ts"], state });
  expect(discovered.state.entries).toHaveLength(258);
  expect(discovered.instructions).toContain("Run tests.");
  expect((await refreshHarnessScopedContext(workspace, discovered.state)).sources).toHaveLength(34);
}));

test("refresh accepts changed, removed and newly created discovered guidance without widening scope", () => fixture(async workspace => {
  await mkdir(path.join(workspace.root, "src/api"), { recursive: true });
  await mkdir(path.join(workspace.root, "other"));
  const original = path.join(workspace.root, "src/AGENTS.md");
  await writeFile(original, "Previous source guidance");
  const { state } = await discoverHarnessScopedContext(workspace, { paths: ["src/api/new.ts"] });
  const before = structuredClone(state);
  await writeFile(original, "Updated source guidance");
  await writeFile(path.join(workspace.root, "src/api/AGENTS.md"), "API guidance");
  await writeFile(path.join(workspace.root, "other/AGENTS.md"), "Undiscovered sibling");
  await writeFile(path.join(workspace.root, "AGENTS.md"), "Root is managed separately");
  await expect(validateHarnessScopedContext(workspace, state)).rejects.toThrow("changed after discovery");
  const changed = await refreshHarnessScopedContext(workspace, state);
  expect(changed.sources.map(source => source.path)).toEqual(["src/AGENTS.md", "src/api/AGENTS.md"]);
  expect(changed.instructions).toContain("Updated source guidance");
  expect(changed.instructions).toContain("API guidance");
  expect(changed.instructions).not.toContain("Undiscovered sibling");
  expect(changed.instructions).not.toContain("Root is managed separately");
  expect(changed.instructions).toContain("cannot relax workspace boundaries");
  expect(changed.instructions).toContain("not authority");
  expect(state).toEqual(before);
  await expect(validateHarnessScopedContext(workspace, changed.state)).resolves.toHaveLength(2);
  await rm(original);
  const removed = await refreshHarnessScopedContext(workspace, changed.state);
  expect(removed.state.entries[0]).toEqual({ path: "src/AGENTS.md", digest: null, bytes: 0 });
  expect(removed.sources).toHaveLength(1);
  expect(removed.instructions).not.toContain("Updated source guidance");
  await writeFile(original, "Recreated guidance");
  expect((await refreshHarnessScopedContext(workspace, removed.state)).instructions).toContain("Recreated guidance");
}));

for (const kind of ["leaf-symlink", "ancestor-symlink", "hardlink", "directory"] as const) {
  test(`refresh rejects ${kind} replacement and preserves prior state`, () => fixture(async workspace => {
    await mkdir(path.join(workspace.root, "src"));
    await mkdir(path.join(workspace.root, "elsewhere"));
    const target = path.join(workspace.root, "src/AGENTS.md");
    const source = path.join(workspace.root, "elsewhere/AGENTS.md");
    await writeFile(target, "Original");
    await writeFile(source, "Must not ingest unsafe guidance");
    const { state } = await discoverHarnessScopedContext(workspace, { paths: ["src/file.ts"] });
    const before = structuredClone(state);
    await rm(target);
    if (kind === "leaf-symlink") await symlink(source, target);
    if (kind === "hardlink") await link(source, target);
    if (kind === "directory") await mkdir(target);
    if (kind === "ancestor-symlink") {
      await rm(path.join(workspace.root, "src"), { recursive: true });
      await symlink("elsewhere", path.join(workspace.root, "src"));
    }
    await expect(refreshHarnessScopedContext(workspace, state)).rejects.toThrow();
    expect(state).toEqual(before);
  }));
}

for (const bytes of [Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(MAX_HARNESS_CONTEXT_FILE_BYTES + 1, "x")]) {
  test(`refresh rejects invalid or oversized content (${bytes.length} bytes)`, () => fixture(async workspace => {
    await mkdir(path.join(workspace.root, "src"));
    const { state } = await discoverHarnessScopedContext(workspace, { paths: ["src/file.ts"] });
    await writeFile(path.join(workspace.root, "src/AGENTS.md"), bytes);
    await expect(refreshHarnessScopedContext(workspace, state)).rejects.toThrow();
    expect(state.entries[0]?.digest).toBeNull();
  }));
}

for (const kind of ["bytes"] as const) {
  test(`refresh enforces aggregate ${kind} limits for previously absent guidance`, () => fixture(async workspace => {
    const count = 5;
    const state: HarnessScopedContextState = { schemaVersion: 1, entries: [] };
    for (let index = 0; index < count; index++) {
      const directory = `scope-${index}`;
      await mkdir(path.join(workspace.root, directory));
      const relativePath = `${directory}/AGENTS.md`;
      state.entries.push({ path: relativePath, digest: null, bytes: 0 });
      await writeFile(path.join(workspace.root, relativePath), kind === "bytes" ? "x".repeat(MAX_HARNESS_CONTEXT_FILE_BYTES) : "guidance");
    }
    await expect(refreshHarnessScopedContext(workspace, state)).rejects.toThrow("aggregate limit");
    expect(state.entries.every(entry => entry.digest === null && entry.bytes === 0)).toBe(true);
  }));
}

test("refresh rejects protected or malformed durable paths and does not scan an empty scope", () => fixture(async workspace => {
  for (const relativePath of ["node_modules/AGENTS.md", "src/../AGENTS.md", "src\\nested/AGENTS.md", "AGENTS.md"]) {
    await expect(refreshHarnessScopedContext(workspace, { schemaVersion: 1,
      entries: [{ path: relativePath, digest: null, bytes: 0 }] })).rejects.toThrow();
  }
  await writeFile(path.join(workspace.root, "AGENTS.md"), "Undiscovered");
  expect(await refreshHarnessScopedContext(workspace, { schemaVersion: 1, entries: [] }))
    .toEqual({ state: { schemaVersion: 1, entries: [] }, sources: [], instructions: "" });
}));

test("refresh treats deleted ancestor directories as absent and retains their discovered identities", () => fixture(async workspace => {
  await mkdir(path.join(workspace.root, "src/api"), { recursive: true });
  await writeFile(path.join(workspace.root, "src/AGENTS.md"), "Source guidance");
  await writeFile(path.join(workspace.root, "src/api/AGENTS.md"), "API guidance");
  const { state } = await discoverHarnessScopedContext(workspace, { paths: ["src/api/file.ts"] });
  await rm(path.join(workspace.root, "src"), { recursive: true });
  const refreshed = await refreshHarnessScopedContext(workspace, state);
  expect(refreshed.state.entries).toEqual([
    { path: "src/AGENTS.md", digest: null, bytes: 0 },
    { path: "src/api/AGENTS.md", digest: null, bytes: 0 }
  ]);
  expect(refreshed.sources).toEqual([]);
  expect(refreshed.instructions).toBe("");
}));
