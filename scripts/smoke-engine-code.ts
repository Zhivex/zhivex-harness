import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const output = process.env.HARNESS_CODE_SMOKE_OUTPUT
  ? path.resolve(process.env.HARNESS_CODE_SMOKE_OUTPUT)
  : await mkdtemp(path.join(os.tmpdir(), "harness-code-artifacts-"));
await mkdir(output, { recursive: true });
const run = (command: string, args: string[], cwd = root) => {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", timeout: 600_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result;
};
run("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", path.join(output, "harness-original.tgz")]);
const stage = path.join(output, "stage"); await mkdir(stage);
run("tar", ["-xzf", path.join(output, "harness-original.tgz"), "-C", stage]);
const stagedManifest = path.join(stage, "package", "package.json");
const manifest = JSON.parse(await readFile(stagedManifest, "utf8"));
const sourceVersion = manifest.version;
// A consumer proof of the unreleased boundary, never a release/version mutation.
manifest.version = "1.3.0-dev.0";
await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
run("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", path.join(output, "harness.tgz")], path.join(stage, "package"));
run("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", path.join(output, "code.tgz")], path.join(root, "packages/code"));
console.log(`Installed consumer proof: source Harness ${sourceVersion}; staged Harness ${manifest.version}; artifacts ${output}. No package published.`);
const result = spawnSync("node", [path.join(root, "scripts/smoke-engine-code.mjs"), path.join(output, "harness.tgz"),
  path.join(output, "code.tgz"), process.argv[2] ?? "npm,pnpm,yarn,bun"], { cwd: root, env: process.env, encoding: "utf8", timeout: 900_000 });
await writeFile(path.join(output, "report.json"), result.stdout ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
