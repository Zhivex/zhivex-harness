import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const workspace = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-package-smoke-"));
const tarball = path.join(temporaryDirectory, "zhivex-harness.tgz");
const consumer = path.join(temporaryDirectory, "consumer");

const commandEnvironment = { ...process.env };
for (const name of [
  "OPENAI_API_KEY",
  "MODEL_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "META_BASE_URL",
  "QWEN_BASE_URL",
  "OPENAI_BASE_URL"
]) {
  delete commandEnvironment[name];
}

const run = async (
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; allowFailure?: boolean } = {}
): Promise<CommandResult> => {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? workspace,
    env: options.env ?? commandEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `${command.join(" ")} failed with exit ${exitCode}\n${stdout}\n${stderr}`
    );
  }
  return { exitCode, stdout, stderr };
};

let succeeded = false;
try {
  await mkdir(consumer, { recursive: true });
  await run(["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", tarball]);
  assert((await stat(tarball)).isFile(), "bun pm pack did not create a tarball");

  const archive = await run(["tar", "-tzf", tarball]);
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/ROADMAP.md",
    "package/CHANGELOG.md",
    "package/docs/CLI.md",
    "package/docs/REPOSITORY_EDITING.md",
    "package/docs/RELEASE.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cli.js"
  ]) {
    assert(archive.stdout.split(/\r?\n/).includes(required), `packed artifact is missing ${required}`);
  }
  for (const forbidden of ["package/.env", "package/src/", "package/tests/"]) {
    assert(!archive.stdout.includes(forbidden), `packed artifact contains ${forbidden}`);
  }

  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({
      name: "zhivex-harness-installed-smoke",
      private: true,
      type: "module",
      scripts: {
        test: "bun -e \"console.log('test-ok')\"",
        typecheck: "bun -e \"console.log('typecheck-ok')\"",
        lint: "bun -e \"console.log('lint-ok')\"",
        build: "bun -e \"console.log('build-ok')\""
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await run(["git", "init", "--quiet"], { cwd: consumer });
  await run(["bun", "add", "--ignore-scripts", tarball], { cwd: consumer });

  const installedManifest = JSON.parse(
    await readFile(path.join(consumer, "node_modules", "@zhivex-ai", "harness", "package.json"), "utf8")
  ) as { name: string; version: string };
  assert.equal(installedManifest.name, manifest.name);
  assert.equal(installedManifest.version, manifest.version);

  const installedCli = path.join(consumer, "node_modules", ".bin", "zhivex-harness");
  const version = await run([installedCli, "--version"], { cwd: consumer });
  assert(version.stdout.includes(manifest.version), "installed CLI version does not match package.json");
  const help = await run([installedCli, "--help"], { cwd: consumer });
  assert(help.stdout.includes("Zhivex Harness"), "installed CLI help is unavailable");

  const providers = await run([installedCli, "providers", "--json"], { cwd: consumer });
  JSON.parse(providers.stdout);
  assert(!providers.stdout.includes("package-smoke-secret"), "provider output exposed a credential");

  const doctor = await run([installedCli, "doctor", "--json"], {
    cwd: consumer,
    env: { ...commandEnvironment, OPENAI_API_KEY: "package-smoke-secret" }
  });
  const doctorDocument = JSON.parse(doctor.stdout) as { kind?: string; ok?: boolean; schemaVersion?: number };
  assert.deepEqual(
    { kind: doctorDocument.kind, ok: doctorDocument.ok, schemaVersion: doctorDocument.schemaVersion },
    { kind: "doctor", ok: true, schemaVersion: 1 }
  );
  assert(!doctor.stdout.includes("package-smoke-secret"), "doctor output exposed a credential");

  const installedSmokeSource = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createEditProposal, createHarness, runHarness } from "@zhivex-ai/harness";
import { createFileAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

const workspace = process.cwd();
const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
const changes = [{ path: "installed-approved.txt", expectedDigest: null, content: "exactly-once\\n" }];
const proposal = createEditProposal({ changes });
const firstStore = createFileAgentRunStore({ directory: stateDirectory });
const firstHarness = await createHarness({
  provider: "openai",
  workspace,
  store: firstStore,
  modelInstance: createMockLanguageModel({
    provider: "installed-mock",
    modelId: "installed-mock-model",
    streamEvents: [
      [
        {
          type: "tool-call",
          toolCall: {
            id: "installed-proposal-1",
            name: "propose_edits",
            input: { changes }
          }
        },
        { type: "finish", finishReason: "tool-calls" }
      ],
      [
        {
          type: "tool-call",
          toolCall: {
            id: "installed-apply-1",
            name: "apply_patch",
            input: { proposalId: proposal.proposalId, changes }
          }
        },
        { type: "finish", finishReason: "tool-calls" }
      ]
    ]
  })
});

const waiting = await runHarness(firstHarness, { prompt: "Create installed-approved.txt" });
assert.equal(waiting.status, "waiting_approval");
await assert.rejects(readFile(path.join(workspace, "installed-approved.txt"), "utf8"));

const restartedStore = createFileAgentRunStore({ directory: stateDirectory });
const checkpoint = await restartedStore.load(waiting.state.runId);
assert(checkpoint);
const restartedHarness = await createHarness({
  provider: "openai",
  workspace,
  store: restartedStore,
  modelInstance: createMockLanguageModel({
    provider: "installed-mock",
    modelId: "installed-mock-model",
    streamEvents: [[
      { type: "text-delta", textDelta: "installed-smoke-ok" },
      { type: "finish", finishReason: "stop" }
    ]]
  })
});
const completed = await runHarness(restartedHarness, {
  state: checkpoint,
  approvals: checkpoint.pendingApprovals.map((approval) => ({
    provider: approval.provider,
    approvalRequestId: approval.id,
    approve: true,
    reason: "Installed package smoke approval."
  }))
});
assert.equal(completed.status, "completed");
assert.equal(completed.toolResults.filter((result) => result.toolName === "apply_patch").length, 1);
assert.equal(await readFile(path.join(workspace, "installed-approved.txt"), "utf8"), "exactly-once\\n");
console.log("INSTALLED_HARNESS_SMOKE_OK");
`;
  const installedSmokePath = path.join(consumer, "installed-smoke.ts");
  await writeFile(installedSmokePath, installedSmokeSource, "utf8");
  const installedSmoke = await run(["bun", "run", installedSmokePath], { cwd: consumer });
  assert(installedSmoke.stdout.includes("INSTALLED_HARNESS_SMOKE_OK"));

  succeeded = true;
  process.stdout.write(`Installed package smoke passed for ${manifest.name}@${manifest.version}.\n`);
} finally {
  if (succeeded) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } else {
    process.stderr.write(`Installed package smoke retained its fixture at ${temporaryDirectory}.\n`);
  }
}
