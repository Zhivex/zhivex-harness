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
  engines?: { node?: string; bun?: string };
  publishConfig?: { access?: string; provenance?: boolean; registry?: string };
};
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-package-smoke-"));
const providedTarball = process.argv[2];
const tarball = providedTarball
  ? path.resolve(process.cwd(), providedTarball)
  : path.join(temporaryDirectory, "zhivex-harness.tgz");
const consumer = path.join(temporaryDirectory, "consumer");

const commandEnvironment = { ...process.env };
commandEnvironment.NPM_CONFIG_CACHE = path.join(temporaryDirectory, "npm-cache");
for (const name of [
  "OPENAI_API_KEY",
  "MODEL_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "META_BASE_URL",
  "QWEN_BASE_URL",
  "OPENAI_BASE_URL",
  "GEMINI_BASE_URL"
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
  if (!providedTarball) {
    await run(["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", tarball]);
  }
  assert((await stat(tarball)).isFile(), "bun pm pack did not create a tarball");

  const archive = await run(["tar", "-tzf", tarball]);
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/ROADMAP.md",
    "package/CHANGELOG.md",
    "package/SECURITY.md",
    "package/SUPPORT.md",
    "package/docs/CLI.md",
    "package/docs/DURABLE_OPERATIONS.md",
    "package/docs/EXTENSIBILITY.md",
    "package/docs/CHANGE_ENVELOPES.md",
    "package/docs/REPOSITORY_EDITING.md",
    "package/docs/RELEASE.md",
    "package/evaluations/golden-expectations.json",
    "package/examples/mcp-config.json",
    "package/examples/change-envelope-input.json",
    "package/examples/change.patch",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cli.js",
    "package/dist/zhx.js",
    "package/dist/hostile-repository-demo.js"
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
      packageManager: "npm@11.5.1",
      scripts: {
        test: "node -e \"console.log('test-ok')\"",
        typecheck: "node -e \"console.log('typecheck-ok')\"",
        lint: "node -e \"console.log('lint-ok')\"",
        build: "node -e \"console.log('build-ok')\""
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await run(["git", "init", "--quiet"], { cwd: consumer });
  await run([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball
  ], { cwd: consumer });

  const installedPackageRoot = path.join(consumer, "node_modules", "@zhivex-ai", "harness");
  const installedManifest = JSON.parse(
    await readFile(path.join(installedPackageRoot, "package.json"), "utf8")
  ) as {
    name: string;
    version: string;
    private?: boolean;
    publishConfig?: { access?: string; provenance?: boolean; registry?: string };
    bin?: Record<string, string>;
    engines?: { node?: string; bun?: string };
  };
  assert.equal(installedManifest.name, manifest.name);
  assert.equal(installedManifest.version, manifest.version);
  assert.notEqual(installedManifest.private, true, "installed package is still private");
  assert.deepEqual(installedManifest.publishConfig, manifest.publishConfig);
  assert.deepEqual(installedManifest.engines, manifest.engines);
  assert.equal(installedManifest.engines?.node, ">=22.13.0");
  assert.deepEqual(installedManifest.bin, {
    "zhivex-harness": "./dist/cli.js",
    zhx: "./dist/zhx.js"
  });

  const installedCli = path.join(consumer, "node_modules", ".bin", "zhivex-harness");
  const installedShortCli = path.join(consumer, "node_modules", ".bin", "zhx");
  for (const cli of [installedCli, installedShortCli]) {
    const version = await run([cli, "--version"], { cwd: consumer });
    assert(version.stdout.includes(manifest.version), `installed ${path.basename(cli)} version does not match package.json`);
    assert.equal(version.stderr, "", `installed ${path.basename(cli)} version emitted an unexpected warning`);
    const help = await run([cli, "--help"], { cwd: consumer });
    assert(help.stdout.includes("Zhivex Harness"), `installed ${path.basename(cli)} help is unavailable`);
    assert.equal(help.stderr, "", `installed ${path.basename(cli)} help emitted an unexpected warning`);
  }

  const nodeImport = await run([
    "node",
    "--input-type=module",
    "-e",
    'import("@zhivex-ai/harness").then((module) => console.log(module.HARNESS_VERSION))'
  ], { cwd: consumer });
  assert(nodeImport.stdout.includes(manifest.version), "installed package is not importable through Node");
  assert.equal(nodeImport.stderr, "", "plain Node library import emitted an unexpected warning");

  const providers = await run([installedCli, "providers", "--json"], { cwd: consumer });
  const providersDocument = JSON.parse(providers.stdout) as {
    providers?: Array<{ id?: string; support?: string }>;
  };
  assert(providersDocument.providers?.some((provider) =>
    provider.id === "gemini" && provider.support === "provisional"
  ));
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

  const installedEnvelopePath = path.join(consumer, "installed-change-envelope.json");
  const installedEnvelope = await run([
    installedCli,
    "changes",
    "create",
    path.join(installedPackageRoot, "examples", "change-envelope-input.json"),
    "--patch",
    path.join(installedPackageRoot, "examples", "change.patch")
  ], { cwd: consumer });
  const installedEnvelopeDocument = JSON.parse(installedEnvelope.stdout) as {
    kind?: string;
    envelopeId?: string;
  };
  assert.equal(installedEnvelopeDocument.kind, "change-envelope");
  assert.match(installedEnvelopeDocument.envelopeId ?? "", /^sha256:[a-f0-9]{64}$/);
  await writeFile(installedEnvelopePath, installedEnvelope.stdout, "utf8");
  const installedEnvelopeVerification = await run([
    installedShortCli,
    "changes",
    "verify",
    installedEnvelopePath,
    "--patch",
    path.join(installedPackageRoot, "examples", "change.patch")
  ], { cwd: consumer });
  assert.deepEqual(
    (({ kind, valid, verificationScope }) => ({ kind, valid, verificationScope }))(
      JSON.parse(installedEnvelopeVerification.stdout) as {
        kind?: string;
        valid?: boolean;
        verificationScope?: string;
      }
    ),
    {
      kind: "change-envelope-verification",
      valid: true,
      verificationScope: "integrity-expiration-and-preconditions-only"
    }
  );

  const bunCreatedRunPath = path.join(consumer, "bun-created-run.json");
  const bunCreationSource = `
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEditProposal, createHarness, runHarness } from "@zhivex-ai/harness";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

const workspace = process.cwd();
const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
const changes = [{ path: "installed-approved.txt", expectedDigest: null, content: "fixture-sensitive-payload\\n" }];
const proposal = createEditProposal({ changes });
const harness = await createHarness({
  provider: "openai",
  workspace,
  stateDirectory,
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
const waiting = await runHarness(harness, {
  prompt: "Create installed-approved.txt",
  idempotencyKey: "installed-request-42",
  scope: harness.config.scope
});
assert.equal(waiting.status, "waiting_approval");
await assert.rejects(readFile(path.join(workspace, "installed-approved.txt"), "utf8"));
await writeFile("bun-created-run.json", JSON.stringify({ runId: waiting.state.runId }), "utf8");
harness.close();
console.log("BUN_CREATED_DURABLE_RUN_OK");
`;
  const bunCreationPath = path.join(consumer, "bun-create-durable-run.mjs");
  await writeFile(bunCreationPath, bunCreationSource, "utf8");
  const bunCreation = await run(["bun", bunCreationPath], { cwd: consumer });
  assert(bunCreation.stdout.includes("BUN_CREATED_DURABLE_RUN_OK"));
  assert((await stat(bunCreatedRunPath)).isFile());

  const installedSmokeSource = `
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HARNESS_SQLITE_FILE,
  DEFAULT_PROVIDER_REGISTRY,
  Workspace,
  createChangeEnvelope,
  createHarness,
  createHarnessOciExecutionEnvironment,
  digestChangeEnvelopeArtifact,
  inspectHarnessModelCapabilities,
  inspectHarnessRun,
  listHarnessRuns,
  normalizeHarnessMcpConfiguration,
  openCliSessionStore,
  parseHarnessModelRoute,
  resolveHarnessConfig,
  runHarness,
  streamEventDocument,
  verifyChangeEnvelope
} from "@zhivex-ai/harness";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

const workspace = process.cwd();
const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
const installedDemo = await import(pathToFileURL(path.join(
  workspace,
  "node_modules",
  "@zhivex-ai",
  "harness",
  "dist",
  "hostile-repository-demo.js"
)).href);
assert.equal(typeof installedDemo.runHostileRepositoryDemo, "function");
assert.equal(typeof createChangeEnvelope, "function");
assert.equal(typeof digestChangeEnvelopeArtifact, "function");
assert.equal(typeof verifyChangeEnvelope, "function");
const bunCreatedRun = JSON.parse(await readFile(path.join(workspace, "bun-created-run.json"), "utf8"));
assert.equal(DEFAULT_PROVIDER_REGISTRY.has("gemini"), true);
assert.equal(parseHarnessModelRoute("reviewer=gemini").provider, "gemini");
assert.equal(streamEventDocument({ type: "text-delta", textDelta: "ok" }, 1).sequence, 1);
assert.throws(() => normalizeHarnessMcpConfiguration({
  schemaVersion: 1,
  servers: [{
    name: "unsafe",
    transport: "http",
    url: "http://example.com",
    includeTools: ["lookup"],
    permissions: ["network"]
  }]
}));
await assert.rejects(readFile(path.join(workspace, "installed-approved.txt"), "utf8"));

const restartedHarness = await createHarness({
  provider: "openai",
  workspace,
  stateDirectory,
  modelInstance: createMockLanguageModel({
    provider: "installed-mock",
    modelId: "installed-mock-model",
    streamEvents: [[
      { type: "text-delta", textDelta: "installed-smoke-ok" },
      { type: "finish", finishReason: "stop" }
    ]]
  })
});
assert.equal(restartedHarness.config.schemaVersion, 4);
assert.deepEqual([...restartedHarness.subagents.keys()], ["explorer", "implementer", "tester", "reviewer"]);
assert.equal(inspectHarnessModelCapabilities(restartedHarness.agent.model).capabilities.tools, true);
const checkpoint = await restartedHarness.store.load(bunCreatedRun.runId, restartedHarness.config.scope);
assert(checkpoint);
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
assert.equal(await readFile(path.join(workspace, "installed-approved.txt"), "utf8"), "fixture-sensitive-payload\\n");
const journal = await restartedHarness.store.listToolCalls?.(
  completed.state.runId,
  restartedHarness.config.scope
) ?? [];
assert.equal(
  journal.filter((entry) => entry.toolName === "apply_patch" && entry.status === "completed").length,
  1
);
assert.equal((await listHarnessRuns(restartedHarness.store, restartedHarness.config)).runs.length, 1);
const inspection = await inspectHarnessRun(
  restartedHarness.store,
  restartedHarness.config,
  completed.state.runId
);
assert.equal(inspection.kind, "run-inspection");
assert(!JSON.stringify(inspection).includes("fixture-sensitive-payload"));
assert((await stat(path.join(stateDirectory, HARNESS_SQLITE_FILE))).isFile());
restartedHarness.close();

const cliSessions = await openCliSessionStore({
  workspace,
  stateDirectory,
  scope: restartedHarness.config.scope
});
const installedCliSession = await cliSessions.create({ title: "installed smoke" });
assert.equal((await cliSessions.get(installedCliSession.sessionId))?.title, "installed smoke");
cliSessions.close();

const executionConfig = resolveHarnessConfig({ workspace, stateDirectory, executionBackend: "oci" });
assert.equal(executionConfig.execution.backend, "oci");
if (executionConfig.execution.backend !== "oci") throw new Error("Expected installed OCI config.");
const fakeRuntime = {
  inspectImage: async (imageReference) => ({
    runtime: "docker",
    runtimeVersion: "installed-fixture",
    imageReference,
    imageId: "sha256:" + "a".repeat(64),
    imageDigest: "sha256:" + "a".repeat(64)
  }),
  run: async (request) => {
    await writeFile(path.join(request.snapshotRoot, "isolated-installed.txt"), "isolated-installed-ok\\n");
    return {
      command: request.command,
      exitCode: 0,
      stdout: "installed-oci-ok\\n",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputLimitExceeded: false
    };
  },
  removeRunContainers: async () => 0,
  cleanupOrphans: async () => 0
};
const installedWorkspace = await Workspace.open(workspace);
assert.equal((await installedWorkspace.readFiles([{ path: "package.json" }])).files.length, 1);
assert.equal((await installedWorkspace.searchMany([
  { query: "zhivex-harness-installed-smoke" },
  { query: "operations.sqlite" }
])).results.length, 2);
const installedEnvironment = await createHarnessOciExecutionEnvironment({
  config: executionConfig.execution,
  workspace: installedWorkspace,
  stateDirectory,
  runtime: fakeRuntime
});
const installedSession = await installedEnvironment.acquire({ runId: "installed-oci-run" });
await installedSession.runCommand("npm", ["test"]);
await assert.rejects(readFile(path.join(workspace, "isolated-installed.txt"), "utf8"));
const installedPatch = await installedSession.inspectPatch();
assert.equal(installedPatch.entries.some((entry) => entry.path === "isolated-installed.txt"), true);
await installedSession.importPatch(installedWorkspace, installedPatch.patchId);
assert.equal(await readFile(path.join(workspace, "isolated-installed.txt"), "utf8"), "isolated-installed-ok\\n");
await installedSession.release?.({ status: "completed" });
console.log("INSTALLED_HARNESS_SMOKE_OK");
`;
  const installedSmokePath = path.join(consumer, "installed-smoke.mjs");
  await writeFile(installedSmokePath, installedSmokeSource, "utf8");
  const installedSmoke = await run(["node", installedSmokePath], { cwd: consumer });
  assert(installedSmoke.stdout.includes("INSTALLED_HARNESS_SMOKE_OK"));

  const bunImport = await run([
    "bun",
    "-e",
    'import("@zhivex-ai/harness").then((module) => console.log(module.HARNESS_VERSION))'
  ], { cwd: consumer });
  assert(bunImport.stdout.includes(manifest.version), "installed package is not importable through Bun");

  const sessionList = await run([installedShortCli, "sessions", "list", "--json"], { cwd: consumer });
  const sessionListDocument = JSON.parse(sessionList.stdout) as { kind?: string; sessions?: unknown[] };
  assert.equal(sessionListDocument.kind, "session-list");
  assert.equal(sessionListDocument.sessions?.length, 1);

  const runList = await run([installedCli, "runs", "list", "--json"], { cwd: consumer });
  const runListDocument = JSON.parse(runList.stdout) as { kind?: string; runs?: unknown[] };
  assert.equal(runListDocument.kind, "run-list");
  assert.equal(runListDocument.runs?.length, 1);

  succeeded = true;
  process.stdout.write(`Installed package smoke passed for ${manifest.name}@${manifest.version}.\n`);
} finally {
  if (succeeded) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } else {
    process.stderr.write(`Installed package smoke retained its fixture at ${temporaryDirectory}.\n`);
  }
}
