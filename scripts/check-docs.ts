import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as {
  version: string;
  private?: boolean;
  publishConfig?: unknown;
  files?: string[];
  scripts?: Record<string, string>;
};

const markdownFiles = [
  path.join(workspace, "README.md"),
  path.join(workspace, "ROADMAP.md"),
  path.join(workspace, "CHANGELOG.md"),
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
const providerConfig = await readFile(path.join(workspace, "src", "config.ts"), "utf8");
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

if (failures.length > 0) {
  throw new Error(`Documentation check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Documentation check passed for ${markdownFiles.length} files and version ${manifest.version}.\n`);
