/** Frozen-cohort installed CLI pilot. All edits occur in disposable git archives. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPortableProcess } from "../src/process-runtime.js";
import { resolveHarnessConfig } from "../src/config.js";
import { openHarnessPersistence } from "../src/operations.js";

const prepareOnly = process.argv.includes("--prepare-only");
assert(prepareOnly || process.env.ZHIVEX_HARNESS_LIVE === "1", "Explicit live opt-in required.");
const [label, cli, split, reportPath] = process.argv.slice(2);
assert(label && cli && path.isAbsolute(cli) && ["development", "evaluation"].includes(split ?? "") && reportPath);
const cohortPath = path.resolve(import.meta.dir, "../evaluations/daily-cli-cohort.json");
const cohortBytes = await readFile(cohortPath);
const cohort = JSON.parse(cohortBytes.toString()) as {
  name: string; provider: string; model: string;
  limits: { maxSteps: number; maxInputTokens: number; maxOutputTokens: number; timeoutMs: number };
  repositories: Record<string, { commit: string; url: string }>;
  tasks: { id: string; split: string; repository: string; kind: string; file: string; prompt: string;
    oracle?: string; answerTerms?: string[]; seed?: { old: string; new: string } }[];
};
const repositoryPaths: Record<string, string> = {
  harness: path.resolve(import.meta.dir, ".."),
  sdk: process.env.HARNESS_PILOT_SDK_PATH ?? "/Users/miguelortiz/Desktop/dev/SDK/zhivex-ai-sdk"
};
const rows: Record<string, unknown>[] = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "OPENAI_API_KEY", "OPENAI_BASE_URL"].includes(key)));
const run = (args: string[], cwd: string, timeoutMs = 30_000) => runPortableProcess(args, { cwd, env,
  timeoutMs, maxOutputCharacters: 3 * 1024 * 1024 });
const checked = async (args: string[], cwd: string) => { const r = await run(args, cwd); assert.equal(r.exitCode, 0, `Preparation failed: ${args[0]}`); return r; };
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
const report = () => ({ schemaVersion: 1, kind: "daily-cli-pilot", label, split, observedAt: new Date().toISOString(),
  cohort: cohort.name, cohortSha256: createHash("sha256").update(cohortBytes).digest("hex"),
  installedCliSha256: createHash("sha256").update(cliBytes).digest("hex"), provider: cohort.provider,
  model: cohort.model, limits: cohort.limits, repositories: cohort.repositories, rows,
  limitations: ["Single attempt per task/artifact; ten curated tasks are not a population estimate.",
    "Seeded repairs and scoped features in real repository snapshots, not unsolicited changes to projects.",
    "Programmatic operator approval policy; not a human usability study.", "Costs unknown; provider token counters are not invoices.",
    "macOS/Node local evidence; no protected release certification or competitive parity claim."] });
const cliBytes = await readFile(cli);
for (const task of cohort.tasks.filter(t => t.split === split)) {
  const root = await mkdtemp(path.join(os.tmpdir(), `har-pilot-${task.id}-`));
  const workspace = path.join(root, "repo"); await mkdir(workspace);
  const stateDirectory = path.join(root, "state");
  const started = Date.now();
  let phase = "prepare";
  try {
    const source = repositoryPaths[task.repository]; assert(source);
    await checked(["git", "archive", "--format=tar", "--output", path.join(root, "repo.tar"), cohort.repositories[task.repository]!.commit], source);
    await checked(["tar", "-xf", path.join(root, "repo.tar"), "-C", workspace], root);
    const originalTarget = await readFile(path.join(workspace, task.file), "utf8");
    if (task.seed) {
      const file = path.join(workspace, task.file); const text = await readFile(file, "utf8");
      assert.equal(text.split(task.seed.old).length, 2, "Seed must match exactly once");
      await writeFile(file, text.replace(task.seed.old, task.seed.new));
    }
    const manifestPath = path.join(workspace, "package.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packageManager = "bun@1.4.0"; manifest.scripts.pilot = "bun run pilot-check.ts";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(path.join(workspace, "pilot-check.ts"), `import assert from 'node:assert/strict';\n${task.oracle ?? "assert.ok(true);"}\nconsole.log('PILOT_ORACLE_OK');\n`);
    await checked(["git", "init", "-q"], workspace);
    await checked(["git", "add", "."], workspace);
    await checked(["git", "-c", "user.name=Harness Pilot", "-c", "user.email=pilot@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", "Frozen pilot input"], workspace);
    const before = await run(["bun", "--no-env-file", "run", "pilot-check.ts"], workspace);
    if (task.kind !== "read") assert.notEqual(before.exitCode, 0, "Repair/feature oracle must fail initially");
    if (task.seed) {
      const target = path.join(workspace, task.file);
      const seeded = await readFile(target, "utf8");
      await writeFile(target, originalTarget);
      const reference = await run(["bun", "--no-env-file", "run", "pilot-check.ts"], workspace);
      assert.equal(reference.exitCode, 0, "Reference implementation must satisfy the independent repair oracle");
      await writeFile(target, seeded);
    }
    if (prepareOnly) {
      rows.push({ taskId: task.id, repository: task.repository, kind: task.kind, result: "prepared-only", phase,
        initialOracleExit: before.exitCode, providerCalls: 0, costUsd: null, costStatus: "not-executed" });
      continue;
    }
    const specPath = path.join(root, "spec.json");
    await writeFile(specPath, JSON.stringify({ cli, workspace, stateDirectory, provider: cohort.provider, model: cohort.model,
      limits: cohort.limits, prompt: task.prompt, editable: task.kind === "read" ? [] : [task.file] }));
    phase = "agent";
    const child = await run(["python3", path.resolve(import.meta.dir, "daily-cli-pty.py"), specPath], root, cohort.limits.timeoutMs + 30_000);
    assert.equal(child.exitCode, 0, "PTY driver failed");
    const observed = JSON.parse(child.stdout) as { terminal: string; exitCode: number; timedOut: boolean; elapsedMs: number; approvals: number; denials: number };
    phase = "verify";
    const after = await run(["bun", "--no-env-file", "run", "pilot-check.ts"], workspace);
    const changed = (await checked(["git", "diff", "--name-only"], workspace)).stdout.trim().split("\n").filter(Boolean);
    const added = (await checked(["git", "ls-files", "--others", "--exclude-standard"], workspace)).stdout.trim().split("\n").filter(Boolean);
    const files = [...changed, ...added];
    const scopePreserved = files.every(file => task.kind !== "read" && file === task.file);
    const listed = await run(["node", cli, "runs", "list", "--workspace", workspace, "--state-dir", stateDirectory, "--json"], workspace);
    const runs = listed.exitCode === 0 ? JSON.parse(listed.stdout).runs : [];
    const runId = runs?.[0]?.runId;
    const inspected = runId ? await run(["node", cli, "runs", "inspect", runId, "--workspace", workspace, "--state-dir", stateDirectory, "--json"], workspace) : undefined;
    const inspection = inspected?.exitCode === 0 ? JSON.parse(inspected.stdout) : undefined;
    // Judge only the durable assistant answer, never echoed prompts/tool previews.
    const config = resolveHarnessConfig({ workspace, stateDirectory });
    const persistence = await openHarnessPersistence(config);
    let answer = "";
    try {
      const state = runId ? await persistence.store.load(runId, config.scope) : undefined;
      answer = (state?.outputText ?? "").replace(/[, _]/g, "").toLowerCase();
    } finally { persistence.close(); }
    const correct = scopePreserved && (task.kind === "read"
      ? task.answerTerms!.every(term => answer.includes(term.replace(/[, _]/g, "").toLowerCase()))
      : after.exitCode === 0 && files.includes(task.file));
    rows.push({ taskId: task.id, repository: task.repository, kind: task.kind, result: correct ? "correct" : "incorrect",
      runtimeStatus: inspection?.run?.status ?? "unavailable", exitCode: observed.exitCode, timedOut: observed.timedOut,
      initialOracleExit: before.exitCode, finalOracleExit: after.exitCode, scopePreserved, changedFiles: files,
      latencyMs: observed.elapsedMs, approvals: observed.approvals, denials: observed.denials,
      interventions: observed.approvals + observed.denials, usage: inspection?.budget?.consumption ?? null,
      costUsd: null, costStatus: "unknown", phase, elapsedMs: Date.now() - started });
  } catch (error) {
    rows.push({ taskId: task.id, repository: task.repository, kind: task.kind, result: "incomplete", phase,
      errorType: error instanceof Error ? error.name : "Error", elapsedMs: Date.now() - started,
      costUsd: null, costStatus: "unknown" });
  } finally {
    await writeFile(reportPath, JSON.stringify(report(), null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
    const last = rows.at(-1)!;
    process.stdout.write(`${label} ${task.id}: ${last.result} (${last.phase})\n`);
  }
}
