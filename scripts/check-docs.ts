import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { findReleaseChangelogHeading } from "./release-changelog.js";

const workspace = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as {
  version: string;
  private?: boolean;
  publishConfig?: unknown;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  keywords?: string[];
  bin?: Record<string, string>;
  engines?: { node?: string; bun?: string };
  packageManager?: string;
};

const markdownFiles = [
  path.join(workspace, "README.md"),
  path.join(workspace, "ROADMAP.md"),
  path.join(workspace, "CHANGELOG.md"),
  path.join(workspace, "CONTRIBUTING.md"),
  path.join(workspace, "SECURITY.md"),
  path.join(workspace, "SUPPORT.md"),
  path.join(workspace, "benchmarks", "README.md"),
  path.join(workspace, "results", "README.md"),
  ...(await readdir(path.join(workspace, "docs"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(workspace, "docs", entry.name))
].sort();

const failures: string[] = [];
for (const markdownFile of markdownFiles) {
  const contents = await readFile(markdownFile, "utf8");
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of contents.matchAll(linkPattern)) {
    const href = match[1]?.replace(/^<|>$/g, "");
    if (!href || href.startsWith("#") || /^(?:https?:|mailto:)/.test(href)) {
      continue;
    }
    const target = decodeURIComponent(href.split("#", 1)[0] ?? "");
    if (!target) {
      continue;
    }
    try {
      await stat(path.resolve(path.dirname(markdownFile), target));
    } catch {
      failures.push(`${path.relative(workspace, markdownFile)}: missing local link target ${target}`);
    }
  }
}

const readme = await readFile(path.join(workspace, "README.md"), "utf8");
const roadmap = await readFile(path.join(workspace, "ROADMAP.md"), "utf8");
const changelog = await readFile(path.join(workspace, "CHANGELOG.md"), "utf8");
const liveCertification = await readFile(path.join(workspace, "docs", "LIVE_CERTIFICATION.md"), "utf8");
const providerConfig = `${await readFile(path.join(workspace, "src", "config.ts"), "utf8")}\n${
  await readFile(path.join(workspace, "src", "providers.ts"), "utf8")
}`;
const liveCertificationWorkflow = await readFile(
  path.join(workspace, ".github", "workflows", "live-certification.yml"),
  "utf8"
);
if (!readme.includes(`Version \`${manifest.version}\``)) {
  failures.push(`README.md does not identify package version ${manifest.version}.`);
}
if (!changelog.includes(`## ${manifest.version} -`)) {
  failures.push(`CHANGELOG.md has no release entry for ${manifest.version}.`);
}

if (manifest.version.startsWith("0.3.")) {
  const repositoryEditingPath = path.join(workspace, "docs", "REPOSITORY_EDITING.md");
  let repositoryEditing = "";
  try {
    repositoryEditing = await readFile(repositoryEditingPath, "utf8");
  } catch {
    failures.push("docs/REPOSITORY_EDITING.md is required for the 0.3.x editing contract.");
  }

  for (const required of [
    "## Propose and apply",
    "## Move, quarantine, and restore",
    "## Git inspection and final summary",
    "## Migration from 0.2.x",
    "## Known limits"
  ]) {
    if (repositoryEditing && !repositoryEditing.includes(required)) {
      failures.push(`docs/REPOSITORY_EDITING.md is missing ${required}.`);
    }
  }

  if (!changelog.includes("## 0.3.0 -") || !changelog.includes("### Migration")) {
    failures.push("CHANGELOG.md must include the 0.3.0 entry and migration notes.");
  }
  if (!roadmap.includes("Validated private candidate")) {
    failures.push("ROADMAP.md does not identify 0.3.0 as a validated private candidate.");
  }
  if (manifest.private !== true || manifest.publishConfig !== undefined) {
    failures.push("package.json must keep the 0.3.x milestone private and omit publishConfig.");
  }

}

if (manifest.version.startsWith("0.4.")) {
  const durableOperationsPath = path.join(workspace, "docs", "DURABLE_OPERATIONS.md");
  let durableOperations = "";
  try {
    durableOperations = await readFile(durableOperationsPath, "utf8");
  } catch {
    failures.push("docs/DURABLE_OPERATIONS.md is required for the 0.4.x operations contract.");
  }
  for (const required of [
    "## Scope and identity",
    "## Operator commands",
    "## Budgets",
    "## Context compaction",
    "## Redaction and exports",
    "## Migration from 0.3.x",
    "## Evaluation gate"
  ]) {
    if (durableOperations && !durableOperations.includes(required)) {
      failures.push(`docs/DURABLE_OPERATIONS.md is missing ${required}.`);
    }
  }
  if (!providerConfig.includes("HARNESS_CONFIG_SCHEMA_VERSION = 2")) {
    failures.push("src/config.ts must identify configuration schema version 2 for 0.4.x.");
  }
  if (!changelog.includes("## 0.4.0 -") || !changelog.includes("### Migration")) {
    failures.push("CHANGELOG.md must include the 0.4.0 entry and migration notes.");
  }
  if (!roadmap.includes("Validated private candidate")) {
    failures.push("ROADMAP.md does not identify 0.4.0 as a validated private candidate.");
  }
  if (manifest.private !== true || manifest.publishConfig !== undefined) {
    failures.push("package.json must keep the 0.4.x milestone private and omit publishConfig.");
  }
  if (manifest.scripts?.evaluate !== "bun run scripts/evaluate.ts") {
    failures.push("package.json must expose the deterministic 0.4.x evaluation gate.");
  }
  if (!manifest.scripts?.check?.includes("bun run evaluate")) {
    failures.push("package.json check must include the deterministic evaluation gate.");
  }
  if (!manifest.files?.includes("evaluations")) {
    failures.push("package.json must include the golden evaluation baseline in packed artifacts.");
  }
  try {
    const golden = JSON.parse(await readFile(
      path.join(workspace, "evaluations", "golden-expectations.json"),
      "utf8"
    )) as { schemaVersion?: number; cases?: unknown[] };
    if (golden.schemaVersion !== 1 || golden.cases?.length !== 5) {
      failures.push("evaluations/golden-expectations.json must contain five schema-version-1 cases.");
    }
  } catch {
    failures.push("evaluations/golden-expectations.json is required and must be valid JSON.");
  }
}

if (manifest.version.startsWith("0.5.")) {
  const extensibilityPath = path.join(workspace, "docs", "EXTENSIBILITY.md");
  let extensibility = "";
  try {
    extensibility = await readFile(extensibilityPath, "utf8");
  } catch {
    failures.push("docs/EXTENSIBILITY.md is required for the 0.5.x orchestration contract.");
  }
  for (const required of [
    "## Capability gate",
    "## Declarative MCP configuration",
    "## MCP result boundary",
    "## Named subagent profiles",
    "## Budgets and cancellation",
    "## Application-owned parallel review",
    "## Progress and JSON",
    "## Migration from 0.4.x",
    "## Known limits"
  ]) {
    if (extensibility && !extensibility.includes(required)) {
      failures.push(`docs/EXTENSIBILITY.md is missing ${required}.`);
    }
  }
  if (!providerConfig.includes("HARNESS_CONFIG_SCHEMA_VERSION = 3")) {
    failures.push("src/config.ts must identify configuration schema version 3 for 0.5.x.");
  }
  if (!changelog.includes("## 0.5.0 -") || !changelog.includes("### Migration")) {
    failures.push("CHANGELOG.md must include the 0.5.0 entry and migration notes.");
  }
  if (!roadmap.includes("Publication-ready candidate")) {
    failures.push("ROADMAP.md does not identify 0.5.0 as a publication-ready candidate.");
  }
  const publishConfig = manifest.publishConfig as {
    access?: string;
    provenance?: boolean;
    registry?: string;
  } | undefined;
  if (
    manifest.private === true ||
    publishConfig?.access !== "public" ||
    publishConfig.provenance !== true ||
    publishConfig.registry !== "https://registry.npmjs.org/"
  ) {
    failures.push("package.json must configure the 0.5.x artifact for public npm publication with provenance.");
  }
  if (manifest.scripts?.evaluate !== "bun run scripts/evaluate.ts" || !manifest.scripts?.check?.includes("bun run evaluate")) {
    failures.push("package.json must retain the deterministic evaluation gate for 0.5.x.");
  }
  if (manifest.scripts?.["smoke:live:orchestration"] !== "bun --env-file=.env run scripts/live-orchestration-smoke.ts") {
    failures.push("package.json must expose the opt-in 0.5.x live orchestration gate.");
  }
  if (
    manifest.scripts?.["smoke:mcp"] !== "bun run scripts/mcp-interoperability-smoke.ts" ||
    !manifest.scripts?.check?.includes("bun run smoke:mcp")
  ) {
    failures.push("package.json must retain the controlled MCP interoperability gate.");
  }
  if (!manifest.files?.includes("evaluations") || !manifest.files?.includes("examples")) {
    failures.push("package.json must include evaluation and example assets in packed artifacts.");
  }
  for (const requiredFile of ["SECURITY.md", "SUPPORT.md"]) {
    if (!manifest.files?.includes(requiredFile)) {
      failures.push(`package.json must include ${requiredFile} in packed artifacts.`);
    }
  }
  if (
    manifest.scripts?.["release:check"] === undefined ||
    manifest.scripts?.["release:status"] === undefined ||
    manifest.scripts?.["release:verify"] === undefined ||
    manifest.scripts?.["artifact:check"] === undefined ||
    manifest.scripts?.["smoke:artifact"] === undefined
  ) {
    failures.push("package.json must expose prepublish, postpublish, exact-artifact, and installed-artifact gates.");
  }
  try {
    const golden = JSON.parse(await readFile(
      path.join(workspace, "evaluations", "golden-expectations.json"),
      "utf8"
    )) as { schemaVersion?: number; cases?: unknown[] };
    if (golden.schemaVersion !== 1 || golden.cases?.length !== 7) {
      failures.push("evaluations/golden-expectations.json must contain seven schema-version-1 cases.");
    }
  } catch {
    failures.push("evaluations/golden-expectations.json is required and must be valid JSON.");
  }
  try {
    const example = JSON.parse(await readFile(
      path.join(workspace, "examples", "mcp-config.json"),
      "utf8"
    )) as { schemaVersion?: number; servers?: unknown[] };
    if (example.schemaVersion !== 1 || !example.servers?.length) {
      failures.push("examples/mcp-config.json must contain a schema-version-1 server example.");
    }
  } catch {
    failures.push("examples/mcp-config.json is required and must be valid JSON.");
  }
}

if (manifest.version.startsWith("0.6.")) {
  const executionPath = path.join(workspace, "docs", "EXECUTION_ENVIRONMENTS.md");
  const hostileDemoPath = path.join(workspace, "docs", "HOSTILE_REPOSITORY_DEMO.md");
  let execution = "";
  let hostileDemo = "";
  try {
    execution = await readFile(executionPath, "utf8");
  } catch {
    failures.push("docs/EXECUTION_ENVIRONMENTS.md is required for the 0.6.x isolation contract.");
  }
  try {
    hostileDemo = await readFile(hostileDemoPath, "utf8");
  } catch {
    failures.push("docs/HOSTILE_REPOSITORY_DEMO.md is required for the 0.6.x product proof.");
  }
  for (const required of [
    "## Trust boundary",
    "## OCI configuration",
    "## Snapshot and patch import",
    "## Resource and network policy",
    "## Lifecycle and recovery",
    "## Migration from 0.5.x",
    "## Certification",
    "## Known limits"
  ]) {
    if (execution && !execution.includes(required)) {
      failures.push(`docs/EXECUTION_ENVIRONMENTS.md is missing ${required}.`);
    }
  }
  if (!providerConfig.includes("HARNESS_CONFIG_SCHEMA_VERSION = 4")) {
    failures.push("src/config.ts must identify configuration schema version 4 for 0.6.x.");
  }
  if (!changelog.includes("## 0.6.0 -") || !changelog.includes("### Migration")) {
    failures.push("CHANGELOG.md must include the 0.6.0 entry and migration notes.");
  }
  if (!roadmap.includes("0.6.0 is published on npm")) {
    failures.push("ROADMAP.md does not identify 0.6.0 as published on npm.");
  }
  if (
    manifest.description !==
      "Governed, provider-portable runtime for coding agents with durable approvals and isolated repository execution."
  ) {
    failures.push("0.6.x package metadata must lead with the governed execution position.");
  }
  for (const keyword of ["agent-runtime", "agent-governance", "sandbox", "durable-workflows", "mcp", "bun"]) {
    if (!manifest.keywords?.includes(keyword)) {
      failures.push(`0.6.x package metadata is missing the ${keyword} discovery keyword.`);
    }
  }
  if (
    manifest.scripts?.["demo:hostile"] !== "bun run dist/hostile-repository-demo.js" ||
    !readme.includes("## Prove the boundary in five minutes") ||
    !hostileDemo.includes("## What it proves") ||
    !hostileDemo.includes("## Evidence limits")
  ) {
    failures.push("0.6.x must expose and document the hostile-repository product proof.");
  }
  if (
    manifest.scripts?.["smoke:oci"] !== "bun run scripts/oci-execution-smoke.ts" ||
    !manifest.scripts?.check?.includes("bun run smoke:oci")
  ) {
    failures.push("package.json must include the enforced OCI smoke in the complete check gate.");
  }
  if (
    manifest.scripts?.["smoke:mcp:official"] !== "bun run scripts/mcp-official-sdk-smoke.ts" ||
    !manifest.scripts?.check?.includes("bun run smoke:mcp:official")
  ) {
    failures.push("package.json must include the official MCP SDK interoperability gate.");
  }
  if (
    manifest.dependencies?.["@zhivex-ai/core"] !== "1.6.0" ||
    manifest.overrides?.["@zhivex-ai/core"] !== "1.6.0"
  ) {
    failures.push("0.6.x must pin and override one @zhivex-ai/core@1.6.0 runtime.");
  }
  if (
    !liveCertificationWorkflow.includes("bun run smoke:oci") ||
    !liveCertificationWorkflow.includes("bun run smoke:live:execution")
  ) {
    failures.push("Live certification workflow must exercise the enforced OCI boundary and model-directed execution.");
  }
}

if (manifest.version.startsWith("0.8.")) {
  const cli = await readFile(path.join(workspace, "docs", "CLI.md"), "utf8");
  const durableOperations = await readFile(path.join(workspace, "docs", "DURABLE_OPERATIONS.md"), "utf8");
  const extensibility = await readFile(path.join(workspace, "docs", "EXTENSIBILITY.md"), "utf8");
  for (const [file, contents, headings] of [
    ["docs/CLI.md", cli, ["## Interactive console", "## JSON Lines", "## Command compatibility"]],
    ["docs/DURABLE_OPERATIONS.md", durableOperations, ["## Durable CLI sessions", "## Provider handoff safety", "## Migration from 0.7.x"]],
    ["docs/EXTENSIBILITY.md", extensibility, ["## Provider registry", "## Per-role model routing", "## Routing limits"]]
  ] as const) {
    for (const heading of headings) {
      if (!contents.includes(heading)) failures.push(`${file} is missing ${heading}.`);
    }
  }
  if (manifest.bin?.zhx !== "./dist/zhx.js" || manifest.bin?.["zhivex-harness"] !== "./dist/cli.js") {
    failures.push("0.8.x must publish both zhx and zhivex-harness aliases.");
  }
  const expectedSdkDependencies = {
    "@zhivex-ai/agents": "1.2.0",
    "@zhivex-ai/core": "1.7.0",
    "@zhivex-ai/gemini": "0.10.5",
    "@zhivex-ai/meta": "0.2.2",
    "@zhivex-ai/openai": "0.9.6",
    "@zhivex-ai/qwen": "0.10.2"
  } as const;
  for (const [packageName, expectedVersion] of Object.entries(expectedSdkDependencies)) {
    if (manifest.dependencies?.[packageName] !== expectedVersion) {
      failures.push(`0.8.x must pin ${packageName}@${expectedVersion}.`);
    }
    if (!extensibility.includes(`\`${packageName}@${expectedVersion}\``)) {
      failures.push(`docs/EXTENSIBILITY.md must document ${packageName}@${expectedVersion}.`);
    }
  }
  if (manifest.overrides?.["@zhivex-ai/core"] !== expectedSdkDependencies["@zhivex-ai/core"]) {
    failures.push("0.8.x must override one @zhivex-ai/core@1.7.0 runtime.");
  }
  if (!providerConfig.includes('defaultModel: "gpt-5.6-luna"')) {
    failures.push("0.8.x must use gpt-5.6-luna as the OpenAI default model.");
  }
  for (const modelId of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
    if (!liveCertification.includes(`\`${modelId}\``)) {
      failures.push(`docs/LIVE_CERTIFICATION.md must record the local OpenAI base-gate result for ${modelId}.`);
    }
    if (!extensibility.includes(`\`${modelId}\``)) {
      failures.push(`docs/EXTENSIBILITY.md must document the GPT-5.6 OpenAI model ${modelId}.`);
    }
  }
  if (
    manifest.scripts?.["smoke:live:routing"] !== "bun --env-file=.env run scripts/live-routing-smoke.ts" ||
    !liveCertificationWorkflow.includes("bun run smoke:live:routing")
  ) {
    failures.push("0.8.x must expose the mixed-provider live routing gate.");
  }
  for (const required of ["id: \"gemini\"", "createProviderRegistry", "transportFingerprint"]) {
    if (!providerConfig.includes(required)) failures.push(`0.8.x provider registry is missing ${required}.`);
  }
  if (!findReleaseChangelogHeading(changelog, manifest.version) || !changelog.includes("### Migration from 0.7.x")) {
    failures.push(`CHANGELOG.md must include a candidate or ISO-dated ${manifest.version} heading and migration notes.`);
  }
  if (!roadmap.includes("0.8.0` is the source release candidate")) {
    failures.push("ROADMAP.md must identify the 0.8.0 source release candidate.");
  }
  if (
    !liveCertificationWorkflow.includes("GEMINI_API_KEY") ||
    !liveCertificationWorkflow.includes("GOOGLE_GENERATIVE_AI_API_KEY")
  ) {
    failures.push("Live certification must accept both Gemini credential names.");
  }
}

if (manifest.version.startsWith("0.9.")) {
  const cli = await readFile(path.join(workspace, "docs", "CLI.md"), "utf8");
  const changeEnvelopes = await readFile(path.join(workspace, "docs", "CHANGE_ENVELOPES.md"), "utf8");
  const repositoryEditing = await readFile(path.join(workspace, "docs", "REPOSITORY_EDITING.md"), "utf8");
  const executionEnvironments = await readFile(path.join(workspace, "docs", "EXECUTION_ENVIRONMENTS.md"), "utf8");
  const source = `${await readFile(path.join(workspace, "src", "harness.ts"), "utf8")}\n${
    await readFile(path.join(workspace, "src", "change-envelope.ts"), "utf8")
  }\n${await readFile(path.join(workspace, "src", "cli.ts"), "utf8")}`;
  for (const heading of [
    "## What it proves",
    "## Create and verify",
    "## Verification preconditions",
    "## Authenticity boundary",
    "## Library API",
    "## Known limits"
  ]) {
    if (!changeEnvelopes.includes(heading)) {
      failures.push(`docs/CHANGE_ENVELOPES.md is missing ${heading}.`);
    }
  }
  for (const required of [
    "changes create",
    "changes verify",
    "change-envelope-verification",
    "authenticity: \"not-verified\""
  ]) {
    if (!cli.includes(required)) failures.push(`docs/CLI.md is missing the 0.9.x contract text: ${required}.`);
  }
  for (const required of ["topology-only index", "`read_files`", "`search_many`"]) {
    if (!repositoryEditing.includes(required)) {
      failures.push(`docs/REPOSITORY_EDITING.md is missing the 0.9.x contract text: ${required}.`);
    }
  }
  for (const required of ["copy-on-write", "changed files", "`environment_status`"]) {
    if (!executionEnvironments.includes(required)) {
      failures.push(`docs/EXECUTION_ENVIRONMENTS.md is missing the 0.9.x optimization text: ${required}.`);
    }
  }
  for (const required of [
    "createChangeEnvelope",
    "verifyChangeEnvelope",
    "integrity-expiration-and-preconditions-only",
    "read_files",
    "search_many"
  ]) {
    if (!source.includes(required)) failures.push(`0.9.x source contract is missing ${required}.`);
  }
  if (manifest.scripts?.["benchmark:workspace"] !== "bun run scripts/benchmark-workspace.ts") {
    failures.push("0.9.x must expose the reproducible workspace benchmark.");
  }
  if (
    manifest.scripts?.["benchmark:workspace:ci"] !==
      "bun run scripts/benchmark-workspace.ts --files 1000 --page-size 100" ||
    !manifest.scripts?.check?.includes("bun run benchmark:workspace:ci")
  ) {
    failures.push("0.9.x must execute the bounded workspace benchmark smoke in the complete check gate.");
  }
  if (manifest.bin?.zhx !== "./dist/zhx.js" || manifest.bin?.["zhivex-harness"] !== "./dist/cli.js") {
    failures.push("0.9.x must retain both zhx and zhivex-harness aliases.");
  }
  const expectedSdkDependencies = {
    "@zhivex-ai/agents": "1.2.0",
    "@zhivex-ai/core": "1.7.0",
    "@zhivex-ai/gemini": "0.10.5",
    "@zhivex-ai/meta": "0.2.2",
    "@zhivex-ai/openai": "0.9.6",
    "@zhivex-ai/qwen": "0.10.2"
  } as const;
  for (const [packageName, expectedVersion] of Object.entries(expectedSdkDependencies)) {
    if (manifest.dependencies?.[packageName] !== expectedVersion) {
      failures.push(`0.9.x must retain ${packageName}@${expectedVersion}.`);
    }
  }
  if (manifest.overrides?.["@zhivex-ai/core"] !== expectedSdkDependencies["@zhivex-ai/core"]) {
    failures.push("0.9.x must retain one @zhivex-ai/core@1.7.0 runtime.");
  }
  if (!findReleaseChangelogHeading(changelog, manifest.version) || !changelog.includes("### Migration from 0.8.x")) {
    failures.push(`CHANGELOG.md must include a candidate or ISO-dated ${manifest.version} heading and migration notes.`);
  }
  if (!roadmap.includes("`0.9.0` is the source candidate")) {
    failures.push("ROADMAP.md must identify the 0.9.0 source candidate.");
  }
}

if (manifest.version.startsWith("0.10.")) {
  const cli = await readFile(path.join(workspace, "docs", "CLI.md"), "utf8");
  const durableOperations = await readFile(path.join(workspace, "docs", "DURABLE_OPERATIONS.md"), "utf8");
  const repositoryEditing = await readFile(path.join(workspace, "docs", "REPOSITORY_EDITING.md"), "utf8");
  const executionEnvironments = await readFile(path.join(workspace, "docs", "EXECUTION_ENVIRONMENTS.md"), "utf8");
  const timeToSafeFix = await readFile(path.join(workspace, "docs", "TIME_TO_SAFE_FIX.md"), "utf8");
  const timeToSafeFixBaseline = JSON.parse(await readFile(
    path.join(workspace, "benchmarks", "baselines", "time-to-safe-fix-live-smoke-2026-08-21.json"),
    "utf8"
  )) as {
    schemaVersion?: number;
    kind?: string;
    profiles?: unknown[];
    evidenceBoundary?: unknown[];
    [key: string]: unknown;
  };
  const ciWorkflow = await readFile(path.join(workspace, ".github", "workflows", "ci.yml"), "utf8");
  const releaseWorkflow = await readFile(path.join(workspace, ".github", "workflows", "release.yml"), "utf8");
  const runtimeSource = await Promise.all([
    "cli.ts",
    "operations.ts",
    "sessions.ts",
    "workspace.ts",
    "execution-environment.ts"
  ].map((file) => readFile(path.join(workspace, "src", file), "utf8")));
  const packageManagerSource = await readFile(path.join(workspace, "src", "package-manager.ts"), "utf8");
  const sqliteSource = await readFile(path.join(workspace, "src", "sqlite-database.ts"), "utf8");
  const processSource = await readFile(path.join(workspace, "src", "process-runtime.ts"), "utf8");

  if (
    manifest.engines?.node !== ">=22.13.0" ||
    manifest.engines?.bun !== ">=1.3.7" ||
    manifest.packageManager !== "bun@1.3.7"
  ) {
    failures.push("0.10.x must declare Node-first runtime support and retain pinned Bun contributor tooling.");
  }
  if (
    manifest.scripts?.start !== "node dist/cli.js" ||
    !manifest.scripts?.build?.includes("--target node") ||
    manifest.bin?.zhx !== "./dist/zhx.js" ||
    manifest.bin?.["zhivex-harness"] !== "./dist/cli.js"
  ) {
    failures.push("0.10.x must build and expose both CLI aliases for Node.");
  }
  if (runtimeSource.some((source) => source.includes("bun:sqlite") || source.includes("Bun.spawn") || source.includes("#!/usr/bin/env bun"))) {
    failures.push("0.10.x runtime-facing source must not require bun:sqlite, Bun.spawn, or a Bun CLI shebang.");
  }
  if (!sqliteSource.includes('from "node:sqlite"') || !processSource.includes('from "node:child_process"')) {
    failures.push("0.10.x must keep SQLite and host subprocess execution on explicit Node-compatible adapters.");
  }
  for (const required of ["npm", "pnpm", "yarn", "bun", "Ambiguous package manager", "implicit ${lifecycleName}"]) {
    if (!packageManagerSource.includes(required)) {
      failures.push(`0.10.x package-manager resolver is missing ${required}.`);
    }
  }
  for (const required of ["Node-first", "Node.js 22.13.0", "node:24-bookworm-slim", "npx --yes --package=@zhivex-ai/harness@0.10.0"]) {
    if (!readme.includes(required)) failures.push(`README.md is missing the 0.10.x runtime contract: ${required}.`);
  }
  if (
    !cli.includes("active Node/Bun runtime") ||
    !cli.includes("at least one supported repository package manager") ||
    !repositoryEditing.includes("package manager")
  ) {
    failures.push("0.10.x CLI and repository-editing docs must explain runtime and package-manager selection.");
  }
  if (
    !durableOperations.includes("node:sqlite") ||
    !durableOperations.includes("does not alter the SQLite file") ||
    !durableOperations.includes("Migration from 0.9.x") ||
    !durableOperations.includes("Node.js `22.13.0` or newer") ||
    !durableOperations.includes("require no conversion")
  ) {
    failures.push("0.10.x durable-operations docs must state SQLite compatibility explicitly.");
  }
  for (const required of ["node:24-bookworm-slim", "Migration from 0.9.x", "2026-08-21-v3"]) {
    if (!executionEnvironments.includes(required)) {
      failures.push(`docs/EXECUTION_ENVIRONMENTS.md is missing the 0.10.x contract: ${required}.`);
    }
  }
  for (const workflow of [ciWorkflow, releaseWorkflow, liveCertificationWorkflow]) {
    if (!workflow.includes("node:24-bookworm-slim") || !workflow.includes("actions/setup-node@")) {
      failures.push("Every 0.10.x validation workflow must set up Node and use the Node 24 OCI image.");
    }
  }
  if (
    !ciWorkflow.includes('"22.13.0"') ||
    !ciWorkflow.includes("Execute the Node-first artifact") ||
    !ciWorkflow.includes("openCliSessionStore")
  ) {
    failures.push("0.10.x CI must exercise the minimum Node runtime, built artifact, and SQLite persistence.");
  }
  if (
    manifest.scripts?.["benchmark:safe-fix"] !== "bun run scripts/benchmark-time-to-safe-fix.ts" ||
    manifest.scripts?.["benchmark:safe-fix:live"] !== "bun --env-file=.env run scripts/benchmark-time-to-safe-fix.ts --driver-zhivex" ||
    manifest.scripts?.["benchmark:safe-fix:live:smoke"] !== "bun --env-file=.env run scripts/benchmark-time-to-safe-fix.ts --tasks 2 --repetitions 1 --profiles direct,governed,optimized --carriers rule_file --driver-zhivex --summary" ||
    manifest.scripts?.["benchmark:safe-fix:baseline"] !== "bun run scripts/create-time-to-safe-fix-baseline.ts" ||
    !manifest.scripts?.check?.includes("bun run benchmark:safe-fix:ci") ||
    !timeToSafeFix.includes("safeResolved") ||
    !timeToSafeFix.includes("not coding capability") ||
    !timeToSafeFix.includes("exactly 12 driver runs") ||
    !timeToSafeFix.includes("ZHIVEX_SAFE_FIX_PROVIDER") ||
    !timeToSafeFix.includes("zhivex-harness/time-to-safe-fix:node24-pytest9") ||
    !readme.includes("Time-to-Safe-Fix benchmark")
  ) {
    failures.push("0.10.x must expose and bound the Time-to-Safe-Fix benchmark and deterministic smoke.");
  }
  const serializedBaseline = JSON.stringify(timeToSafeFixBaseline);
  if (
    timeToSafeFixBaseline.schemaVersion !== 1 ||
    timeToSafeFixBaseline.kind !== "time-to-safe-fix-baseline" ||
    timeToSafeFixBaseline.profiles?.length !== 3 ||
    !timeToSafeFixBaseline.evidenceBoundary?.length ||
    ["host", "command", "worktree", "samples", "reportPath"].some((key) =>
      serializedBaseline.includes(`\"${key}\":`)
    )
  ) {
    failures.push("The committed Time-to-Safe-Fix baseline must be compact, bounded, and sanitized.");
  }
  if (!findReleaseChangelogHeading(changelog, manifest.version) || !changelog.includes("### Migration")) {
    failures.push(`CHANGELOG.md must include a candidate or ISO-dated ${manifest.version} heading and migration notes.`);
  }
  if (!roadmap.includes("`0.10.0` is the source candidate")) {
    failures.push("ROADMAP.md must identify the 0.10.0 Node-first source candidate.");
  }
}

const providerDescriptorMatches = [...providerConfig.matchAll(
  /\{\s*id:\s*"([^"]+)",[\s\S]*?support:\s*"(certified|provisional)"\s*\}/g
)];
const certifiedProviders = providerDescriptorMatches
  .filter((match) => match[2] === "certified")
  .map((match) => match[1]);
const expectedLiveDefault = `default: ${certifiedProviders.join(",")}`;
if (certifiedProviders.length === 0) {
  failures.push("src/config.ts does not identify any certified providers.");
} else if (!liveCertificationWorkflow.includes(expectedLiveDefault)) {
  failures.push(
    `.github/workflows/live-certification.yml must default to every certified provider (${certifiedProviders.join(", ")}).`
  );
}
if (manifest.version.startsWith("0.5.") && !liveCertificationWorkflow.includes("bun run smoke:live:orchestration")) {
  failures.push(".github/workflows/live-certification.yml must run the 0.5.x orchestration matrix.");
}

if (failures.length > 0) {
  throw new Error(`Documentation check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Documentation check passed for ${markdownFiles.length} files and version ${manifest.version}.\n`);
