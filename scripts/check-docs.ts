import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { findReleaseChangelogHeading } from "./release-changelog.js";
import { parseReleaseStatus, type ReleaseStatus } from "./release-status.js";

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
const support = await readFile(path.join(workspace, "SUPPORT.md"), "utf8");
const security = await readFile(path.join(workspace, "SECURITY.md"), "utf8");
const releaseDocumentation = await readFile(path.join(workspace, "docs", "RELEASE.md"), "utf8");
const publicSecurity = await readFile(path.join(workspace, "docs", "PUBLIC_SECURITY.md"), "utf8");
let releaseStatus: ReleaseStatus | undefined;
try {
  releaseStatus = parseReleaseStatus(JSON.parse(await readFile(
    path.join(workspace, "release-status.json"),
    "utf8"
  )));
} catch (error) {
  failures.push(
    `release-status.json is missing or invalid: ${error instanceof Error ? error.message : String(error)}`
  );
}
const expandedTimeToSafeFixTasks = (await readFile(
  path.join(workspace, "evaluations", "time-to-safe-fix-expanded.jsonl"),
  "utf8"
)).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as { task_id?: string });
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
if (releaseStatus) {
  const minor = `${releaseStatus.version.split(".").slice(0, 2).join(".")}.x`;
  if (releaseStatus.version !== manifest.version) {
    failures.push(
      `release-status.json version ${releaseStatus.version} does not match package version ${manifest.version}.`
    );
  }
  if (releaseStatus.status === "published") {
    for (const [file, contents, required] of [
      ["README.md", readme, `Version \`${releaseStatus.version}\` is the current public npm release`],
      ["ROADMAP.md", roadmap, "Status: published on npm as `latest`"],
      ["docs/RELEASE.md", releaseDocumentation, `@zhivex-ai/harness@${releaseStatus.version}\` is the latest public npm release`],
      ["SUPPORT.md", support, `Zhivex Harness \`${minor}\` is the latest supported`],
      ["SECURITY.md", security, `latest published \`${minor}\` patch`]
    ] as const) {
      if (!contents.includes(required)) {
        failures.push(`${file} does not agree with the published release status: ${required}.`);
      }
    }
    for (const [file, contents, stale] of [
      ["README.md", readme, `Version \`${releaseStatus.version}\` is the current source release candidate`],
      ["ROADMAP.md", roadmap, `Version \`${releaseStatus.version}\` is the local source release candidate`],
      ["ROADMAP.md", roadmap, "It is not yet tagged or published as a new artifact"],
      ["docs/RELEASE.md", releaseDocumentation, `Version \`${releaseStatus.version}\` is the current local source release candidate`]
    ] as const) {
      if (contents.includes(stale)) {
        failures.push(`${file} still contains stale candidate state: ${stale}.`);
      }
    }
  }
  if (!readme.includes("[repository release status](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json)")) {
    failures.push("README.md must link the mutable repository release status outside the package.");
  }
}
for (const required of [
  "## Enabled no-cost controls",
  "## Cost-gated controls left disabled",
  "larger GitHub-hosted runners",
  "Local credentials are never copied to GitHub automatically"
]) {
  if (!publicSecurity.includes(required)) {
    failures.push(`docs/PUBLIC_SECURITY.md is missing: ${required}.`);
  }
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

if (manifest.version.startsWith("0.10.") || manifest.version.startsWith("0.11.")) {
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
  const expandedTimeToSafeFixBaseline = JSON.parse(await readFile(
    path.join(workspace, "benchmarks", "baselines", "time-to-safe-fix-live-expanded-2026-08-21.json"),
    "utf8"
  )) as typeof timeToSafeFixBaseline & { dataset?: { tasks?: number }; matrix?: { completedRuns?: number } };
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
    manifest.engines?.bun !== ">=1.4.0" ||
    manifest.packageManager !== "bun@1.4.0"
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
  for (const required of [
    "Node-first",
    "Node.js 22.13.0",
    "node:24-bookworm-slim",
    `npx --yes --package=@zhivex-ai/harness@${manifest.version}`
  ]) {
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
    manifest.scripts?.["benchmark:safe-fix:live:expanded"] !== "bun --env-file=.env run scripts/benchmark-time-to-safe-fix.ts --dataset evaluations/time-to-safe-fix-expanded.jsonl --dataset-name zhivex-time-to-safe-fix-expanded --tasks 12 --repetitions 3 --profiles direct,governed,optimized --carriers rule_file --driver-zhivex --driver-timeout-ms 300000 --summary" ||
    manifest.scripts?.["benchmark:safe-fix:baseline"] !== "bun run scripts/create-time-to-safe-fix-baseline.ts" ||
    expandedTimeToSafeFixTasks.length !== 12 ||
    new Set(expandedTimeToSafeFixTasks.map((task) => task.task_id)).size !== 12 ||
    !manifest.scripts?.check?.includes("bun run benchmark:safe-fix:ci") ||
    !timeToSafeFix.includes("safeResolved") ||
    !timeToSafeFix.includes("not coding capability") ||
    !timeToSafeFix.includes("exactly 12 driver runs") ||
    !timeToSafeFix.includes("ZHIVEX_SAFE_FIX_PROVIDER") ||
    !timeToSafeFix.includes("zhivex-harness/time-to-safe-fix:node24-pytest9") ||
    !executionEnvironments.includes("verify_and_apply_environment_patch") ||
    !timeToSafeFix.includes("verify_and_apply_reviewed_edits") ||
    !timeToSafeFix.includes("sanitized `failure` record") ||
    !timeToSafeFix.includes("allSafeResolved") ||
    !timeToSafeFix.includes("216 sequential driver runs") ||
    !executionEnvironments.includes("failed verifier or changed patch leaves the host untouched") ||
    !executionEnvironments.includes("Applications may explicitly designate this tool as terminal") ||
    !readme.includes("Time-to-Safe-Fix benchmark")
  ) {
    failures.push("0.10.x must expose and bound the Time-to-Safe-Fix benchmark and deterministic smoke.");
  }
  const serializedBaseline = JSON.stringify(timeToSafeFixBaseline);
  const serializedExpandedBaseline = JSON.stringify(expandedTimeToSafeFixBaseline);
  if (
    timeToSafeFixBaseline.schemaVersion !== 1 ||
    timeToSafeFixBaseline.kind !== "time-to-safe-fix-baseline" ||
    timeToSafeFixBaseline.profiles?.length !== 3 ||
    !timeToSafeFixBaseline.profiles?.every((profile: { efficiency?: unknown }) => profile.efficiency) ||
    !timeToSafeFixBaseline.evidenceBoundary?.length ||
    ["host", "command", "worktree", "samples", "reportPath"].some((key) =>
      serializedBaseline.includes(`\"${key}\":`)
    )
  ) {
    failures.push("The committed Time-to-Safe-Fix baseline must be compact, bounded, and sanitized.");
  }
  if (
    expandedTimeToSafeFixBaseline.schemaVersion !== 1 ||
    expandedTimeToSafeFixBaseline.kind !== "time-to-safe-fix-baseline" ||
    expandedTimeToSafeFixBaseline.dataset?.tasks !== 12 ||
    expandedTimeToSafeFixBaseline.matrix?.completedRuns !== 216 ||
    expandedTimeToSafeFixBaseline.profiles?.length !== 3 ||
    !expandedTimeToSafeFixBaseline.profiles?.every((profile: { efficiency?: unknown }) => profile.efficiency) ||
    !expandedTimeToSafeFixBaseline.evidenceBoundary?.length ||
    ["host", "command", "worktree", "samples", "reportPath"].some((key) =>
      serializedExpandedBaseline.includes(`\"${key}\":`)
    )
  ) {
    failures.push("The expanded Time-to-Safe-Fix baseline must retain 216 sanitized observations.");
  }
  if (!findReleaseChangelogHeading(changelog, manifest.version) || !changelog.includes("### Migration")) {
    failures.push(`CHANGELOG.md must include a candidate or ISO-dated ${manifest.version} heading and migration notes.`);
  }
  const publishedThrough = manifest.version.startsWith("0.11.") ? "0.11.0" : "0.10.0";
  if (!roadmap.includes(`\`0.5.0\` through \`${publishedThrough}\` are published on npm`)) {
    failures.push(`ROADMAP.md must identify ${publishedThrough} as a published Node-first release.`);
  }
}

if (manifest.version.startsWith("0.11.")) {
  const cli = await readFile(path.join(workspace, "docs", "CLI.md"), "utf8");
  const contextEngineering = await readFile(
    path.join(workspace, "docs", "CONTEXT_ENGINEERING.md"),
    "utf8"
  );
  const executionEnvironments = await readFile(
    path.join(workspace, "docs", "EXECUTION_ENVIRONMENTS.md"),
    "utf8"
  );
  const contextSource = await readFile(path.join(workspace, "src", "context-engineering.ts"), "utf8");
  const terminalSource = await readFile(path.join(workspace, "src", "terminal-ui.ts"), "utf8");
  const harnessSource = await readFile(path.join(workspace, "src", "harness.ts"), "utf8");

  for (const heading of [
    "## Discovery and precedence",
    "## Progressive skills",
    "## Lifecycle hooks",
    "## Durable compatibility"
  ]) {
    if (!contextEngineering.includes(heading)) {
      failures.push(`docs/CONTEXT_ENGINEERING.md is missing ${heading}.`);
    }
  }
  for (const required of [
    "/pending",
    "/approve",
    "/deny",
    "--no-project-context",
    "--oci-shell <deny|ask>"
  ]) {
    if (!cli.includes(required)) failures.push(`docs/CLI.md is missing the 0.11.x contract text: ${required}.`);
  }
  for (const required of ["2026-08-21-v4", "run_environment_shell", "sh -lc", "host import approval"]) {
    if (!executionEnvironments.includes(required)) {
      failures.push(`docs/EXECUTION_ENVIRONMENTS.md is missing the 0.11.x contract text: ${required}.`);
    }
  }
  for (const required of [
    "HARNESS_CONTEXT_CONFIG_SCHEMA_VERSION = 1",
    "loadHarnessProjectContext",
    "loadHarnessSkill",
    "createHarnessLifecycleDispatcher"
  ]) {
    if (!contextSource.includes(required)) failures.push(`0.11.x context source is missing ${required}.`);
  }
  for (const required of [
    "sanitizeTerminalText",
    "formatApproval",
    "resolveTerminalApprovals",
    "formatTerminalEvent"
  ]) {
    if (!terminalSource.includes(required)) failures.push(`0.11.x terminal source is missing ${required}.`);
  }
  for (const required of ["load_skill", "run_environment_shell", "lifecycleHooks"]) {
    if (!harnessSource.includes(required)) failures.push(`0.11.x harness source is missing ${required}.`);
  }
  if (!providerConfig.includes("HARNESS_CONFIG_SCHEMA_VERSION = 5")) {
    failures.push("0.11.x must identify configuration schema version 5.");
  }
  if (!providerConfig.includes('HARNESS_EXECUTION_POLICY_VERSION = "2026-08-21-v4"')) {
    failures.push("0.11.x must bind the v4 OCI execution policy.");
  }
  const releaseHeading = findReleaseChangelogHeading(changelog, manifest.version);
  if (!releaseHeading || releaseHeading.kind !== "dated" || !changelog.includes("### Migration from 0.10.x")) {
    failures.push(`CHANGELOG.md must include a dated ${manifest.version} heading and migration from 0.10.x.`);
  }
  if (!roadmap.includes("Status: published on npm as `latest`")) {
    failures.push("ROADMAP.md must identify 0.11.0 as the published latest release.");
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
const releaseWorkflow = await readFile(path.join(workspace, ".github", "workflows", "release.yml"), "utf8");
for (const required of [
  "certify-live:",
  "environment: live-certification",
  "needs.certify-live.result == 'success'",
  "bun run smoke:live",
  "bun run smoke:live:orchestration",
  "bun run smoke:live:routing",
  "bun run smoke:live:execution"
]) {
  if (!releaseWorkflow.includes(required)) {
    failures.push(`.github/workflows/release.yml is missing the release-bound live gate: ${required}.`);
  }
}
if (!liveCertificationWorkflow.includes("ref: ${{ inputs.tag }}") ||
  !liveCertificationWorkflow.includes("fetch-depth: 0") ||
  !liveCertificationWorkflow.includes("--tag \"$RELEASE_TAG\"")) {
  failures.push(".github/workflows/live-certification.yml must bind certification to an exact annotated tag.");
}
for (const [file, workflow] of [
  [".github/workflows/release.yml", releaseWorkflow],
  [".github/workflows/live-certification.yml", liveCertificationWorkflow]
] as const) {
  if (!workflow.includes("description: Annotated vX.Y.Z tag; must match package.json and resolve to main") ||
    !workflow.includes("required: true") || !workflow.includes("type: string")) {
    failures.push(`${file} must require an explicit package-version-bound tag input.`);
  }
  if (/default:\s+v\d+\.\d+\.\d+/.test(workflow)) {
    failures.push(`${file} must not duplicate the package version as a workflow input default.`);
  }
}
const manualLiveSteps = liveCertificationWorkflow.indexOf("\n    steps:");
if (manualLiveSteps === -1 || liveCertificationWorkflow.slice(0, manualLiveSteps).includes("${{ secrets.")) {
  failures.push(".github/workflows/live-certification.yml must not expose provider secrets before its steps begin.");
}
const releaseLiveJob = releaseWorkflow.indexOf("\n  certify-live:");
const releaseLiveSteps = releaseWorkflow.indexOf("\n    steps:", releaseLiveJob);
if (releaseLiveJob === -1 || releaseLiveSteps === -1 ||
  releaseWorkflow.slice(releaseLiveJob, releaseLiveSteps).includes("${{ secrets.")) {
  failures.push(".github/workflows/release.yml must not expose provider secrets at live job scope.");
}
const codeqlWorkflow = await readFile(path.join(workspace, ".github", "workflows", "codeql.yml"), "utf8");
for (const required of [
  "security-events: write",
  "javascript-typescript",
  "queries: security-extended",
  "github/codeql-action/init@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28",
  "github/codeql-action/analyze@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28"
]) {
  if (!codeqlWorkflow.includes(required)) {
    failures.push(`.github/workflows/codeql.yml is missing: ${required}.`);
  }
}
const dependabot = await readFile(path.join(workspace, ".github", "dependabot.yml"), "utf8");
for (const required of ["package-ecosystem: bun", "package-ecosystem: github-actions"]) {
  if (!dependabot.includes(required)) failures.push(`.github/dependabot.yml is missing: ${required}.`);
}
const codeowners = await readFile(path.join(workspace, ".github", "CODEOWNERS"), "utf8");
if (!codeowners.includes("* @mortiz-dev") || !codeowners.includes("/.github/ @mortiz-dev")) {
  failures.push(".github/CODEOWNERS must assign repository and workflow ownership.");
}

if (failures.length > 0) {
  throw new Error(`Documentation check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Documentation check passed for ${markdownFiles.length} files and version ${manifest.version}.\n`);
