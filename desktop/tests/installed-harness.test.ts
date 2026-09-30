import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installedHarness } from "../scripts/installed-harness.js";

test("Desktop build requires the pinned installed candidate and rejects changed bytes or source links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhx-installed-boundary-"));
  const sha256 = createHash("sha256").update("fixture tarball").digest("hex");
  const install = path.join(root, ".harness", sha256);
  const pkg = path.join(install, "node_modules/@zhivex-ai/harness");
  const link = path.join(root, "node_modules/@zhivex-ai/harness");
  try {
    await mkdir(pkg, { recursive: true }); await mkdir(path.dirname(link), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ harness: { version: "1.3.0-rc.3" } }));
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@zhivex-ai/harness", version: "1.3.0-rc.3" }));
    await writeFile(path.join(install, "harness.tgz"), "fixture tarball");
    await writeFile(path.join(root, ".harness/installed.json"), JSON.stringify({ schemaVersion: 1, sha256, version: "1.3.0-rc.3", install }));
    await symlink(pkg, link, "dir");
    expect((await installedHarness(root)).sha256).toBe(sha256);
    await writeFile(path.join(install, "harness.tgz"), "changed");
    await expect(installedHarness(root)).rejects.toThrow("artifact changed");
    await writeFile(path.join(install, "harness.tgz"), "fixture tarball");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ harness: { version: "1.3.0-rc.4" } }));
    await expect(installedHarness(root)).rejects.toThrow("version or package identity");
    await rm(link); await symlink(root, link, "dir");
    await expect(installedHarness(root)).rejects.toThrow("not a source link");
  } finally { await rm(root, { recursive: true, force: true }); }
});
