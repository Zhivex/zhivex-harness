import { mkdtemp, mkdir, writeFile, rename, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { readRegularFileNoFollow } from "../../src/file-security.js";
const root = await mkdtemp(path.join(os.tmpdir(), "zhx-descriptor-"));
try {
  await mkdir(path.join(root, "parent")); await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "parent", "file"), "inside"); await writeFile(path.join(root, "outside", "file"), "outside");
  const read = () => readRegularFileNoFollow(path.join(root, "parent", "file"), { label: "fixture", maxBytes: 100 });
  assert.equal((await read()).contents.toString(), "inside");
  await rename(path.join(root, "parent"), path.join(root, "saved"));
  await symlink(path.join(root, "outside"), path.join(root, "parent"));
  await assert.rejects(read, { name: "UnsafeFileTypeError" });
  await assert.rejects(() => readRegularFileNoFollow(path.join(root, "parent"), { label: "fixture", maxBytes: 100 }));
  console.log(JSON.stringify({ platform: process.platform, runtime: process.versions.bun ? "bun" : "node", ancestorSymlink: "blocked", regularRead: "passed" }));
} finally { await rm(root, { recursive: true, force: true }); }
