import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = path.resolve(packageRoot, "../..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "assistant-installed-"));
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout + result.stderr;
}
try {
  // Build first at the repository root. Never rewrite the engine artifact metadata.
  const artifact = path.join(temporary, "harness.tgz");
  run("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", artifact], repository);
  const consumer = path.join(temporary, "consumer");
  await cp(packageRoot, consumer, { recursive: true, filter: source => !["node_modules", "dist", ".git"].includes(path.basename(source)) });
  const manifestPath = path.join(consumer, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const engine = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  if (manifest.dependencies["@zhivex-ai/harness"] !== engine.version) throw new Error("Assistant engine pin differs from candidate");
  manifest.dependencies["@zhivex-ai/harness"] = "file:../harness.tgz";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // The committed lock describes the registry pin; this temporary consumer tests a candidate.
  await rm(path.join(consumer, "bun.lock"), { force: true });
  run("bun", ["install", "--ignore-scripts"], consumer);
  await writeFile(path.join(consumer, "check-resolution.mjs"), `
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const resolved = realpathSync(fileURLToPath(import.meta.resolve('@zhivex-ai/harness/engine')));
assert.ok(resolved.startsWith(realpathSync('node_modules') + path.sep), resolved);
console.log('Installed public export resolved inside isolated consumer');
`);
  process.stdout.write(run("node", ["check-resolution.mjs"], consumer));
  for (const script of ["typecheck", "test", "smoke"]) process.stdout.write(run("bun", ["run", script], consumer));
  console.log(JSON.stringify({ check: "assistant-installed", engineVersion: engine.version,
    artifactSha256: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: "offline-mock", published: false }));
} finally { await rm(temporary, { recursive: true, force: true }); }
