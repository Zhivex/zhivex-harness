import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverHarnessScopedContext, validateHarnessScopedContext } from "../src/context/scoped-context.js";

const fixture = async (run: (workspace: { root: string }) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-scoped-"));
  try { await run({ root }); } finally { await rm(root, { recursive: true, force: true }); }
};

test("discovers only ancestor instructions in broad-to-specific order without duplicating root", () => fixture(async (workspace) => {
  const { root } = workspace;
  await mkdir(path.join(root, "src/api"), { recursive: true });
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "AGENTS.md"), "Root");
  await writeFile(path.join(root, "src/AGENTS.md"), "All source");
  await writeFile(path.join(root, "src/api/AGENTS.md"), "API only");
  await writeFile(path.join(root, "other/AGENTS.md"), "Other");
  const result = await discoverHarnessScopedContext(workspace, { paths: ["src/api/new.ts", "src/api/another.ts"] });
  expect(result.sources.map((source) => source.path)).toEqual(["src/AGENTS.md", "src/api/AGENTS.md"]);
  expect(result.instructions).toContain("not authority");
  expect(result.instructions).not.toContain("Root");
  expect(result.instructions).not.toContain("Other");
  const again = await discoverHarnessScopedContext(workspace, { paths: ["src/file.ts"], state: JSON.parse(JSON.stringify(result.state)) });
  expect(again.sources).toHaveLength(1);
  expect(again.state).toEqual(result.state);
}));

test("durable state rejects changed, deleted, and newly appearing instructions", () => fixture(async (workspace) => {
  await mkdir(path.join(workspace.root, "src/api"), { recursive: true });
  const target = path.join(workspace.root, "src/AGENTS.md");
  await writeFile(target, "Before");
  const { state } = await discoverHarnessScopedContext(workspace, { paths: ["src/api/file.ts"] });
  expect(state.entries[1]?.digest).toBeNull();
  await writeFile(target, "After");
  await expect(validateHarnessScopedContext(workspace, state)).rejects.toThrow("changed after discovery");
  await rm(target);
  await expect(validateHarnessScopedContext(workspace, state)).rejects.toThrow("changed after discovery");
  await writeFile(target, "Before");
  await writeFile(path.join(workspace.root, "src/api/AGENTS.md"), "New rules");
  await expect(validateHarnessScopedContext(workspace, state)).rejects.toThrow("changed after discovery");
}));

test("rejects escape, protected, ambiguous and sensitive target paths", () => fixture(async (workspace) => {
  for (const target of ["../a.ts", "/tmp/a.ts", "src/../a.ts", "src\\a.ts", "node_modules/a.ts", "src/.env", "src/secret.pem", ".git/config"]) {
    await expect(discoverHarnessScopedContext(workspace, { paths: [target] })).rejects.toThrow();
  }
}));

test("rejects symlinks in ancestor or leaf and hard-linked instructions", () => fixture(async (workspace) => {
  await mkdir(path.join(workspace.root, "real"));
  const original = path.join(workspace.root, "original.txt");
  await writeFile(original, "Private");
  await symlink("real", path.join(workspace.root, "alias"));
  await expect(discoverHarnessScopedContext(workspace, { paths: ["alias/file.ts"] })).rejects.toThrow();
  const instructions = path.join(workspace.root, "real/AGENTS.md");
  await symlink(original, instructions);
  await expect(discoverHarnessScopedContext(workspace, { paths: ["real/file.ts"] })).rejects.toThrow();
  await rm(instructions);
  await link(original, instructions);
  await expect(discoverHarnessScopedContext(workspace, { paths: ["real/file.ts"] })).rejects.toThrow();
}));

test("enforces text and byte limits without mutating previous state", () => fixture(async (workspace) => {
  await mkdir(path.join(workspace.root, "src"));
  const target = path.join(workspace.root, "src/AGENTS.md");
  const state = { schemaVersion: 1 as const, entries: [] };
  await writeFile(target, Buffer.from([0xff]));
  await expect(discoverHarnessScopedContext(workspace, { paths: ["src/file.ts"], state })).rejects.toThrow();
  await writeFile(target, "x".repeat(64 * 1024 + 1));
  await expect(discoverHarnessScopedContext(workspace, { paths: ["src/file.ts"], state })).rejects.toThrow("limit");
  expect(state.entries).toEqual([]);
  await expect(discoverHarnessScopedContext(workspace, { paths: Array.from({ length: 257 }, (_, i) => `p${i}/a.ts`) })).rejects.toThrow();
}));

test("rejects malformed persisted identities before reads", () => fixture(async (workspace) => {
  const state = { schemaVersion: 1 as const, entries: [{ path: "src/AGENTS.md", digest: null, bytes: 10 }] };
  await expect(validateHarnessScopedContext(workspace, state)).rejects.toThrow();
}));
