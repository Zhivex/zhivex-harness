import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readDependency } from "../src/tools/dependency-read.js";

async function fixture(run: (root: string, pkg: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependency-inspection-"));
  const pkg = path.join(root, "node_modules/next");
  try {
    await mkdir(path.join(pkg, "dist/server"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), '{"version":"16.0.0"}');
    await writeFile(path.join(pkg, "headers.d.ts"), 'export { headers } from "./dist/server/headers";');
    await writeFile(path.join(pkg, "dist/server/render.js"), 'const nonce = getScriptNonceFromHeader(headers["content-security-policy"]);\n');
    await writeFile(path.join(pkg, "README.md"), "# CSP\nPass the nonce using request headers.\n");
    await run(root, pkg);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("dependency discovery finds real paths, source and documentation without guessing", () => fixture(async root => {
  const listing = await readDependency(root, { package: "next", action: "list" });
  expect(listing.entries).toContainEqual({ path: "headers.d.ts", type: "file" });
  expect(listing.entries).toContainEqual({ path: "dist", type: "directory" });
  expect((await readDependency(root, { package: "next", file: "README.md" })).content).toContain("request headers");
  const results = await readDependency(root, { package: "next", action: "search", path: "dist", query: "getScriptNonceFromHeader" });
  expect(results.matches).toEqual([{ file: "dist/server/render.js", line: 1, text: 'const nonce = getScriptNonceFromHeader(headers["content-security-policy"]);' }]);
  expect((await readDependency(root, { package: "next", file: "dist/server/render.js" })).content).toContain("getScriptNonce");
  await expect(readDependency(root, { package: "next", file: "dist/headers.d.ts" })).rejects.toThrow("action=list");
}));

test("discovery excludes hidden, nested, linked and hardlinked files; search skips binary", () => fixture(async (root, pkg) => {
  await writeFile(path.join(root, "outside.txt"), "PRIVATE_NEEDLE");
  await writeFile(path.join(pkg, ".env"), "PRIVATE_NEEDLE");
  await mkdir(path.join(pkg, "node_modules/child"), { recursive: true });
  await writeFile(path.join(pkg, "node_modules/child/index.js"), "PRIVATE_NEEDLE");
  await symlink(root, path.join(pkg, "escape"));
  await symlink(path.join(root, "outside.txt"), path.join(pkg, "linked.js"));
  await link(path.join(root, "outside.txt"), path.join(pkg, "hard.js"));
  await writeFile(path.join(pkg, "binary.bin"), Buffer.from([0, 255, 12]));
  const listing = await readDependency(root, { package: "next", action: "list", recursive: true });
  expect(listing.entries?.map(e => e.path)).not.toContain("escape");
  expect(listing.entries?.map(e => e.path)).not.toContain("hard.js");
  expect(listing.entries?.map(e => e.path)).not.toContain(".env");
  expect(listing.entries?.some(e => e.path.includes("node_modules"))).toBe(false);
  const search = await readDependency(root, { package: "next", action: "search", query: "PRIVATE_NEEDLE" });
  expect(search.matches).toEqual([]);
  expect(search.skippedFiles).toBeGreaterThanOrEqual(4);
  for (const action of ["list", "search"] as const) for (const unsafe of ["../", "escape", "node_modules", ".env"]) {
    await expect(readDependency(root, { package: "next", action, path: unsafe, query: "PRIVATE_NEEDLE" })).rejects.toThrow();
  }
  await expect(readDependency(root, { package: "next", file: "binary.bin" })).rejects.toThrow();
}));

test("list/search pagination is bounded and resumes without dropping matches", () => fixture(async root => {
  const first = await readDependency(root, { package: "next", action: "list", recursive: true, limit: 2 });
  expect(first.entries).toHaveLength(2);
  expect(first.nextOffset).toBe(2);
  const second = await readDependency(root, { package: "next", action: "list", recursive: true, offset: first.nextOffset!, limit: 2 });
  expect(second.entries).toHaveLength(2);
  expect(new Set([...first.entries!, ...second.entries!].map(e => e.path)).size).toBe(4);
  const search = await readDependency(root, { package: "next", action: "search", query: "nonce", limit: 1 });
  expect(search.matches).toHaveLength(1);
  expect(search.nextOffset).toBe(1);
  const next = await readDependency(root, { package: "next", action: "search", query: "nonce", limit: 1, offset: 1 });
  expect(next.matches).toHaveLength(1);
  expect(next.matches![0]!.file).not.toBe(search.matches![0]!.file);
  expect(next.nextOffset).toBeNull();
}));

test("search explicitly reports skipped oversized files and rejects missing query", () => fixture(async (root, pkg) => {
  await writeFile(path.join(pkg, "large.js"), "a".repeat(1024 * 1024 + 1));
  const result = await readDependency(root, { package: "next", action: "search", query: "nonce" });
  expect(result.skippedFiles).toBe(1);
  await expect(readDependency(root, { package: "next", file: "large.js" })).rejects.toThrow("1 MiB");
  await expect(readDependency(root, { package: "next", action: "search" })).rejects.toThrow("requires a literal query");
}));

test("search reports aggregate budget exhaustion instead of claiming a complete negative result", () => fixture(async (root, pkg) => {
  for (let i = 0; i < 9; i++) await writeFile(path.join(pkg, `budget-${i}.js`), "a".repeat(1024 * 1024));
  const result = await readDependency(root, { package: "next", action: "search", query: "missing" });
  expect(result.matches).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(result.notice).toContain("Narrow path");
  expect(result.nextOffset).toBeNull();
}));

test("missing packages explain installation and read output remains bounded", () => fixture(async (root, pkg) => {
  await expect(readDependency(root, { package: "missing", action: "list" })).rejects.toThrow("not installed");
  await writeFile(path.join(pkg, "long.md"), "x".repeat(20000));
  const result = await readDependency(root, { package: "next", file: "long.md" });
  expect(result.content).toHaveLength(16000);
  expect(result.truncated).toBe(true);
}));

test("search can resume a returned offset beyond the filesystem entry budget", () => fixture(async (root, pkg) => {
  await writeFile(path.join(pkg, "many-lines.txt"), "match\n".repeat(21000));
  const page = await readDependency(root, { package: "next", action: "search", query: "match", offset: 20000, limit: 200 });
  expect(page.matches).toHaveLength(200);
  expect(page.nextOffset).toBe(20200);
  const next = await readDependency(root, { package: "next", action: "search", query: "match", offset: page.nextOffset!, limit: 200 });
  expect(next.matches).toHaveLength(200);
  expect(next.matches![0]!.line).toBe(20201);
}));

test("inspection works for arbitrary scoped packages and text source/documentation formats", () => fixture(async root => {
  const pkg = path.join(root, "node_modules/@vendor/library");
  await mkdir(path.join(pkg, "docs"), { recursive: true });
  for (const file of ["index.ts", "index.js", "module.mjs", "legacy.cjs", "widget.tsx", "helper.py", "schema.json", "config.yml", "docs/guide.md", "LICENSE"]) {
    await writeFile(path.join(pkg, file), `Example for ${file}\nshared marker`);
    const result = await readDependency(root, { package: "@vendor/library", file });
    expect(result.content).toContain(`Example for ${file}`);
  }
  const result = await readDependency(root, { package: "@vendor/library", action: "search", query: "shared marker" });
  expect(result.matches).toHaveLength(10);
  const docs = await readDependency(root, { package: "@vendor/library", action: "list", path: "docs", query: "guide" });
  expect(docs.entries).toEqual([{ path: "docs/guide.md", type: "file" }]);
  const first = await readDependency(root, { package: "@vendor/library", action: "list", limit: 2 });
  const second = await readDependency(root, { package: "@vendor/library", action: "list", limit: 2, offset: first.nextOffset! });
  expect(first.nextOffset).toBe(2);
  expect(second.entries).toHaveLength(2);
  expect(new Set([...first.entries!, ...second.entries!].map(e => e.path)).size).toBe(4);
}));
