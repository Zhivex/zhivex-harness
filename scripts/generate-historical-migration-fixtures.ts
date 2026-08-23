import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

const workspace = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(workspace, "fixtures", "migrations");
const suppliedTarballDirectory = process.argv.includes("--tarball-dir")
  ? path.resolve(process.argv[process.argv.indexOf("--tarball-dir") + 1] ?? "")
  : undefined;

const releases = [
  {
    version: "0.10.0",
    configSchema: 4,
    integrity: "sha512-ecy7Kj4iKmzgnVd9f21/d3SqFqvUjFk5TPx2Esjg17tRopRzYQglPp9WYTrieBuc9x3Qh/7V/ZafXEprS69ffg==",
    tarball: "https://registry.npmjs.org/@zhivex-ai/harness/-/harness-0.10.0.tgz"
  },
  {
    version: "0.11.1",
    configSchema: 5,
    integrity: "sha512-lF1ZzWi4HKsAUAdrpFb6Gf3afsrv89Mkm6tnqA/EGCHGWKZ7c1qQaM2opxrKFQIFQhfWJO4BrYMWQLDWC840kA==",
    tarball: "https://registry.npmjs.org/@zhivex-ai/harness/-/harness-0.11.1.tgz"
  }
] as const;

interface PublishedHarnessModule {
  HARNESS_VERSION: string;
  HARNESS_CONFIG_SCHEMA_VERSION: number;
  HARNESS_OPERATIONS_SCHEMA_VERSION: number;
  HARNESS_SESSION_SCHEMA_VERSION: number;
  resolveHarnessConfig(input: Record<string, unknown>): Record<string, any>;
  openHarnessPersistence(config: Record<string, any>, options?: Record<string, unknown>): Promise<Record<string, any>>;
  openCliSessionStore(options: Record<string, unknown>): Promise<Record<string, any>>;
  createHarness(options: Record<string, unknown>): Promise<{
    agent: { harness?: unknown };
    close(): Promise<void>;
  }>;
}

const sha512Integrity = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const tarballBytes = async (release: (typeof releases)[number]) => {
  if (suppliedTarballDirectory) {
    return new Uint8Array(await readFile(path.join(
      suppliedTarballDirectory,
      `zhivex-harness-${release.version}.tgz`
    )));
  }
  const response = await fetch(release.tarball, { redirect: "error" });
  if (!response.ok) throw new Error(`Could not download ${release.tarball}: HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
};

const command = (argv: string[]) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
};

const deepReplace = (value: unknown, replacements: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") {
    let normalized = value;
    for (const [source, target] of replacements) normalized = normalized.replaceAll(source, target);
    return normalized;
  }
  if (Array.isArray(value)) return value.map((entry) => deepReplace(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      deepReplace(entry, replacements)
    ]));
  }
  return value;
};

const runState = (
  runId: string,
  scope: Record<string, string>,
  options: { parentRunId?: string; status?: string; pendingApprovals?: unknown[] } = {}
) => ({
  schemaVersion: 1,
  revision: 0,
  runId,
  provider: "openai",
  modelId: "published-fixture-model",
  status: options.status ?? "completed",
  messages: [],
  steps: [],
  toolResults: [],
  currentStep: 0,
  maxSteps: 4,
  outputText: "secret token=abcdefgh12345678",
  pendingApprovals: options.pendingApprovals ?? [],
  compactions: [],
  scope,
  ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
  startedAt: 1_000,
  updatedAt: 2_000
});

await mkdir(outputDirectory, { recursive: true });

for (const release of releases) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `zhivex-historical-${release.version}-`)));
  try {
    const bytes = await tarballBytes(release);
    const actualIntegrity = sha512Integrity(bytes);
    if (actualIntegrity !== release.integrity) {
      throw new Error(`${release.version} integrity mismatch: ${actualIntegrity}.`);
    }
    const archivePath = path.join(root, `zhivex-harness-${release.version}.tgz`);
    await writeFile(archivePath, bytes, { mode: 0o600 });
    command(["tar", "-xzf", archivePath, "-C", root]);
    const packageRoot = path.join(root, "package");
    await symlink(path.join(workspace, "node_modules"), path.join(packageRoot, "node_modules"));
    const published = await import(
      `${pathToFileURL(path.join(packageRoot, "dist", "index.js")).href}?fixture=${release.version}`
    ) as PublishedHarnessModule;
    const publishedCli = await import(
      `${pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href}?fixture=${release.version}`
    ) as { createHarnessResumeMetadata(config: Record<string, unknown>): Record<string, unknown> };
    if (
      published.HARNESS_VERSION !== release.version ||
      published.HARNESS_CONFIG_SCHEMA_VERSION !== release.configSchema ||
      published.HARNESS_OPERATIONS_SCHEMA_VERSION !== 1 ||
      published.HARNESS_SESSION_SCHEMA_VERSION !== 1
    ) {
      throw new Error(`${release.version} published schema metadata is unexpected.`);
    }

    // Use the portable filesystem root as the workspace binding. Session
    // records hash the canonical absolute workspace, so a random mkdtemp path
    // would make the exact historical database impossible to open through the
    // current scoped session API on another machine.
    const fixtureWorkspace = path.parse(root).root;
    const stateDirectory = path.join(root, "state");
    await mkdir(stateDirectory);
    const configInput = {
      schemaVersion: release.configSchema,
      provider: "openai",
      model: "published-fixture-model",
      workspace: fixtureWorkspace,
      stateDirectory,
      storeBackend: "sqlite",
      tenantId: "migration-tenant",
      namespace: "published-fixture",
      projectContext: false,
      executionBackend: "none"
    };
    const config = published.resolveHarnessConfig(configInput);
    const parent = {
      ...runState("published-parent", config.scope),
      idempotencyKey: "published-request"
    };
    const child = runState("published-child", config.scope, { parentRunId: parent.runId });
    const historicalHarness = await published.createHarness({
      ...configInput,
      modelInstance: createMockLanguageModel({
        provider: "published-fixture-provider",
        modelId: "published-fixture-model"
      })
    });
    const harnessBinding = historicalHarness.agent.harness;
    await historicalHarness.close();
    if (!harnessBinding) throw new Error(`${release.version} did not expose a durable harness binding.`);
    const paused = {
      ...runState("published-paused", config.scope, {
        status: "waiting_approval",
        pendingApprovals: [{
          provider: "local",
          id: "approval-published",
          name: "apply_patch",
          arguments: "fixture-sensitive-approval",
          rawData: { source: "published-fixture" }
        }]
      }),
      harness: harnessBinding,
      metadata: publishedCli.createHarnessResumeMetadata(config)
    };

    const persistence = await published.openHarnessPersistence(config, { migrateLegacyFileStore: false });
    await persistence.store.claimIdempotencyKey(parent);
    await persistence.store.save(child);
    await persistence.store.save(paused);
    await persistence.store.saveToolCall({
      runId: child.runId,
      scope: config.scope,
      toolCallId: "published-tool",
      toolName: "read_file",
      status: "completed",
      idempotencyKey: "published-tool-request",
      revision: 0,
      output: { redacted: true },
      completedAt: 2_000,
      updatedAt: 2_000
    });
    await persistence.memory.save({ runId: parent.runId, scope: config.scope, state: parent });
    const page = await persistence.store.list({ limit: 100 }, config.scope);
    const journal = await persistence.store.listToolCalls(child.runId, config.scope);
    const memory = await persistence.memory.load({ runId: parent.runId, scope: config.scope });
    persistence.close();

    let now = 3_000;
    const sessions = await published.openCliSessionStore({
      workspace: fixtureWorkspace,
      stateDirectory,
      scope: config.scope,
      now: () => now++
    });
    const parentSession = await sessions.create({
      title: "published terminal history",
      initialRun: {
        runId: parent.runId,
        provider: parent.provider,
        model: parent.modelId,
        status: "completed"
      }
    });
    await sessions.appendRun(parentSession.sessionId, {
      runId: child.runId,
      provider: child.provider,
      model: child.modelId,
      status: "completed"
    });
    const fork = await sessions.fork(parentSession.sessionId, { title: "published fork" });
    const archived = await sessions.archive(parentSession.sessionId);
    const forked = await sessions.get(fork.sessionId);
    sessions.close();

    const historicalDatabasePath = path.join(stateDirectory, "operations.sqlite");
    const database = new DatabaseSync(historicalDatabasePath);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const tableDefinitions = database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'zhivex_%'
      ORDER BY name
    `).all();
    database.close();
    const sqliteBytes = new Uint8Array(await readFile(historicalDatabasePath));
    const sqliteSha256 = `sha256:${createHash("sha256").update(sqliteBytes).digest("hex")}`;

    const turnIds = [...new Set(
      [...archived.runs, ...(forked?.runs ?? [])]
        .flatMap((run) => [run.turnId, run.sourceTurnId])
        .filter((value): value is string => typeof value === "string")
    )];
    const replacements = new Map<string, string>([
      [await realpath(stateDirectory), "<state-directory>"],
      [stateDirectory, "<state-directory>"],
      [archived.workspaceKey, "<workspace-key>"],
      [archived.scopeKey, "<scope-key>"],
      [parentSession.sessionId, "session-parent"],
      [fork.sessionId, "session-fork"],
      ...turnIds.map((turnId, index) => [turnId, `turn-${index + 1}`] as const)
    ]);
    const fixture = deepReplace({
      schemaVersion: 1,
      kind: "published-migration-fixture",
      provenance: {
        package: "@zhivex-ai/harness",
        version: release.version,
        tarball: release.tarball,
        integrity: release.integrity,
        sqliteSha256,
        generatedBy: "scripts/generate-historical-migration-fixtures.ts",
        dependencySource: "current frozen node_modules; published harness dist is integrity-verified"
      },
      schemas: {
        config: published.HARNESS_CONFIG_SCHEMA_VERSION,
        operations: published.HARNESS_OPERATIONS_SCHEMA_VERSION,
        sessions: published.HARNESS_SESSION_SCHEMA_VERSION
      },
      configInput,
      runs: page.items,
      toolJournal: journal,
      memory,
      sessions: [archived, forked],
      sqliteTables: tableDefinitions
    }, replacements);
    await writeFile(
      path.join(outputDirectory, `${release.version}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      { mode: 0o644 }
    );
    await writeFile(path.join(outputDirectory, `${release.version}.sqlite`), sqliteBytes, { mode: 0o644 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`Generated ${releases.length} integrity-verified historical fixtures.\n`);
