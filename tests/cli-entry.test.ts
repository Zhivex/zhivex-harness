import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HARNESS_VERSION } from "../src/version.js";

test("packaged informational commands avoid provider imports and lazy dispatch preserves errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-entry-"));
  const repo = path.resolve(import.meta.dir, "..");
  try {
    await mkdir(path.join(root, "dist"));
    await copyFile(path.join(repo, "package.json"), path.join(root, "package.json"));
    await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"));
    const build = await Bun.build({ entrypoints: [path.join(repo, "src/cli-entry.ts")],
      outdir: path.join(root, "dist"), target: "node", packages: "external", splitting: true });
    expect(build.success).toBe(true);
    const loader = path.join(root, "deny-provider.mjs");
    await writeFile(loader, `export async function resolve(specifier, context, next) {
      if (specifier.startsWith('@zhivex-ai/')) throw new Error('unexpected provider/runtime import');
      return next(specifier, context);
    }`);
    const invoke = async (args: string[], isolated = false) => {
      const child = Bun.spawn(["node", ...(isolated ? ["--experimental-loader", loader] : []),
        path.join(root, "dist/cli-entry.js"), ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    };
    for (const flag of ["--version", "-v", "version"]) {
      const result = await invoke([flag], true);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(HARNESS_VERSION);
    }
    for (const flag of ["--help", "-h", "help"]) {
      const result = await invoke([flag], true);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Start in your project:");
    }
    const help = await invoke(["run", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: zhx run");
    const error = await invoke(["--definitely-invalid", "--json"]);
    expect(error.code).toBe(2);
    expect(JSON.parse(error.stderr).error.code).toBe("CLI_USAGE_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});
