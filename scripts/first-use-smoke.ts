/** Installed-package first use; deterministic transport, no real credentials or network. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPortableProcess } from "../src/execution/process-runtime.js";
const cli = path.resolve(process.argv[2] ?? "dist/cli.js");
const root = await mkdtemp(path.join(os.tmpdir(), "har-first-use-"));
const workspace = path.join(root, "example"); await mkdir(workspace);
const credential = "first-use-fixture-only";
const env = { PATH: process.env.PATH!, HOME: root, ZHIVEX_HARNESS_CONFIG_DIR: path.join(root, "profiles"),
  OPENAI_API_KEY: credential, FIRST_USE_COUNTER: path.join(root, "calls"),
  NODE_OPTIONS: `--import=${path.resolve(import.meta.dir, "../tests/fixtures/first-use-fetch.mjs")}` };
const run = async (args: string[], overrides: Record<string, string> = {}) => {
  const r = await runPortableProcess(["node", cli, ...args], { cwd: workspace, env: { ...env, ...overrides }, timeoutMs: 30_000, maxOutputCharacters: 128 * 1024 });
  assert(!r.stdout.includes(credential) && !r.stderr.includes(credential), "Credential leaked");
  return r;
};
try {
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "first-use", private: true, type: "module", packageManager: "bun@1.4.0", scripts: { pilot: "bun run pilot-check.ts" } }));
  await writeFile(path.join(workspace, "pilot-check.ts"), "import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('result.txt','utf8'),'first use passed\\n');\n");
  for (const args of [["git", "init", "-q"], ["git", "add", "."], ["git", "-c", "user.name=Harness", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", "fixture"]]) {
    const result = await runPortableProcess(args, { cwd: workspace, env }); assert.equal(result.exitCode, 0);
  }
  assert.equal((await run(["init", "--profile", "first-use", "--provider", "openai", "--model", "gpt-5.6-luna", "--json"])).exitCode, 0);
  const doctor = await run(["doctor", "--profile", "first-use", "--json"]); assert.equal(doctor.exitCode, 0);
  const missing = await run(["doctor", "--profile", "first-use"], { OPENAI_API_KEY: "" });
  assert.equal(missing.exitCode, 3); assert(missing.stdout.includes("Set OPENAI_API_KEY"));
  const started = await run(["run", "--profile", "first-use", "--allow-check", "pilot", "--json", "Complete the guided example with an approved edit, pilot check and diff."]);
  assert.equal(started.exitCode, 0); const waiting = JSON.parse(started.stdout);
  assert.equal(waiting.status, "waiting_approval"); assert.equal(waiting.pendingApprovals[0].name, "apply_reviewed_edits");
  const resumed = await run(["resume", waiting.runId, "--approve", "--json"]);
  assert.equal(resumed.exitCode, 0); const completed = JSON.parse(resumed.stdout);
  assert.equal(completed.status, "completed"); assert.equal(completed.usageLedger.calls, 5);
  assert.equal(await readFile(path.join(workspace, "result.txt"), "utf8"), "first use passed\n");
  const check = await runPortableProcess(["bun", "--no-env-file", "run", "pilot-check.ts"], { cwd: workspace, env }); assert.equal(check.exitCode, 0);
  const unavailable = await run(["run", "--profile", "first-use", "--timeout-ms", "3000", "read the example"], { FIRST_USE_UNAVAILABLE: "1" });
  assert.notEqual(unavailable.exitCode, 0); assert(unavailable.stderr.includes("Recovery:"));
  const invalid = await run(["run", "--profile", "first-use", "read the example"], { OPENAI_API_KEY: "invalid-fixture-key" });
  assert.notEqual(invalid.exitCode, 0); assert(invalid.stderr.includes("Recovery:"));
  // Node is resolved before changing PATH, so the OCI probe cannot discover Docker.
  const nodePath = (await runPortableProcess(["node", "-p", "process.execPath"], { cwd: root, env })).stdout.trim();
  const absentOci = await runPortableProcess([nodePath, cli, "doctor", "--execution", "oci", "--oci-image", `example.invalid/fixture@sha256:${"a".repeat(64)}`], {
    cwd: workspace, env: { ...env, PATH: path.join(root, "empty-path") }, timeoutMs: 30_000 });
  assert.equal(absentOci.exitCode, 3); assert(absentOci.stdout.includes("Start Docker/Podman"));
  console.log("FIRST_USE_OK: installed init/profile, credential redaction, approved edit/check/diff, restart, invalid/missing credentials, provider unavailable, OCI absent. Offline transport only.");
} finally { await rm(root, { recursive: true, force: true }); }
