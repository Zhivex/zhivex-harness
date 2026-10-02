import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "code-installed-journey-"));
const evidence = process.env.CODE_JOURNEY_OUTPUT ? path.resolve(process.env.CODE_JOURNEY_OUTPUT) : scratch;
await mkdir(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "LANG", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "npm_config_cafile"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const run = (command, args, cwd = scratch) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 240_000,
    env: { ...env, HOME: scratch, NO_COLOR: "1", NODE_NO_WARNINGS: "1", npm_config_cache: path.join(scratch, "cache") } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const pack = JSON.parse(run("npm", ["pack", root, "--ignore-scripts", "--json", "--pack-destination", scratch]));
  await writeFile(path.join(scratch, "package.json"), '{"private":true}\n');
  run("npm", ["install", path.join(scratch, pack[0].filename), "--ignore-scripts", "--no-audit", "--no-fund"]);
  const installed = path.join(scratch, "node_modules/@zhivex-ai/code");
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@zhivex-ai/harness"], "1.3.0");
  const harness = path.join(scratch, "node_modules/@zhivex-ai/harness");
  assert.equal(JSON.parse(await readFile(path.join(harness, "package.json"), "utf8")).version, "1.3.0");
  assert.ok((await realpath(harness)).startsWith((await realpath(scratch)) + path.sep), "Harness must be installed from the registry, not the checkout");
  run("python3", [path.join(root, "scripts/installed-journey.py"), installed, evidence]);
  const report = { status: "passed", node: process.version, codeVersion: manifest.version, harnessVersion: "1.3.0",
    installation: "npm tarball with published dependency, no overrides or install scripts", offline: true,
    scenarios: ["task/check approvals and denial", "pending approval exit and resume", "per-file diff and check receipt",
      "per-run estimated budget and unknown cost", "checkpoint capture/review/restore and stale retry rejection", "Ctrl+C, restart, /continue"] };
  await writeFile(path.join(evidence, "installed-journey-report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
