import path from "node:path";

import * as publicApi from "../src/index.js";
import {
  CLI_CHANGES_COMMANDS,
  CLI_COMMANDS,
  CLI_EXIT_CODES,
  CLI_HELP_TEXT,
  CLI_RUNS_COMMANDS,
  CLI_SESSIONS_COMMANDS,
  CLI_STATE_COMMANDS
} from "../src/cli.js";
import { CLI_COMMAND_OPTION_CONTRACTS } from "../src/cli-options.js";
import { CLI_OPTION_NAMES } from "../src/cli-options.js";
import { readRegularFileNoFollow } from "../src/file-security.js";
import {
  GA_REPRESENTATIVE_EVALUATION_PROVIDERS,
  GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
  GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
  assertDistinctGaReleaseCandidateEvidence,
  parseGaReleaseCandidateEvidence,
  parseGaRepresentativeEvaluationCoverage,
  parseGaSecurityReviewEvidencePath,
  verifyGaRepresentativeEvaluationWorkflows,
  verifyPublishedGaReleaseCandidate,
  type GaReleaseCandidateEvidence,
  type GaRepresentativeEvaluationResult
} from "./ga-release-evidence.js";

type JsonObject = Record<string, unknown>;

const workspace = path.resolve(import.meta.dir, "..");
const releaseMode = process.argv.includes("--release");
const failures: string[] = [];

const evidenceIsCurrent = (value: unknown, maxAgeDays: number) => {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= 0 && age <= maxAgeDays * 24 * 60 * 60 * 1_000;
};

const readJson = async (relativePath: string): Promise<JsonObject> => JSON.parse(
  (await readRegularFileNoFollow(path.join(workspace, relativePath), {
    label: `1.0 readiness source ${relativePath}`,
    maxBytes: 4 * 1024 * 1024
  })).contents.toString("utf8")
) as JsonObject;

const existingPath = async (relativePath: unknown, label: string) => {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.includes("..")) {
    failures.push(`${label} must be a workspace-relative path`);
    return;
  }
  try {
    await readRegularFileNoFollow(path.join(workspace, relativePath), {
      label,
      maxBytes: 8 * 1024 * 1024
    });
  } catch (error) {
    failures.push(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const exactStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    failures.push(`${label} must be an array of strings`);
    return [];
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) failures.push(`${label} contains duplicates`);
  if ([...values].sort().join("\n") !== values.join("\n")) failures.push(`${label} must remain sorted`);
  return values;
};

const manifest = await readJson("package.json");
const readiness = await readJson("docs/ga-readiness.json");
const contract = await readJson("contracts/public-api.json");
const support = await readJson("docs/support-matrix.json");
const controls = await readJson("contracts/security-controls.json");
const evaluations = await readJson("evaluations/representative-matrix.json");

if (readiness.schemaVersion !== 1 || readiness.targetVersion !== "1.0.0") {
  failures.push("docs/ga-readiness.json must target schema 1 and version 1.0.0");
}
for (const key of [
  "contractManifest",
  "stabilityPolicy",
  "supportMatrix",
  "securityControls",
  "threatModel",
  "rollbackPolicy",
  "deprecationPolicy",
  "representativeEvaluation"
]) {
  await existingPath(readiness[key], `readiness.${key}`);
}

if (contract.schemaVersion !== 1 || contract.targetVersion !== "1.0.0" || contract.implicitTier !== "beta") {
  failures.push("contracts/public-api.json must define the schema-1 1.0 contract and implicit beta tier");
}
const expectedExports = exactStringArray(contract.runtimeExports, "contract.runtimeExports");
const actualExports = Object.keys(publicApi).sort();
if (expectedExports.join("\n") !== actualExports.join("\n")) {
  const expected = new Set(expectedExports);
  const actual = new Set(actualExports);
  failures.push(
    `public runtime export drift (missing: ${expectedExports.filter((name) => !actual.has(name)).join(", ") || "none"}; ` +
    `unclassified: ${actualExports.filter((name) => !expected.has(name)).join(", ") || "none"})`
  );
}
const stableExports = exactStringArray(contract.stableRuntimeExports, "contract.stableRuntimeExports");
const experimentalExports = exactStringArray(contract.experimentalRuntimeExports, "contract.experimentalRuntimeExports");
const stableTypeExports = exactStringArray(contract.stableTypeExports, "contract.stableTypeExports");
for (const name of [...stableExports, ...experimentalExports]) {
  if (!expectedExports.includes(name)) failures.push(`classified export ${name} is absent from runtimeExports`);
}
for (const name of stableExports) {
  if (experimentalExports.includes(name)) failures.push(`export ${name} cannot be stable and experimental`);
}
const publicIndexSource = (
  await readRegularFileNoFollow(path.join(workspace, "src/index.ts"), {
    label: "public source index",
    maxBytes: 2 * 1024 * 1024
  })
).contents.toString("utf8");
const cliDocumentation = (
  await readRegularFileNoFollow(path.join(workspace, "docs", "CLI.md"), {
    label: "CLI documentation",
    maxBytes: 2 * 1024 * 1024
  })
).contents.toString("utf8");
for (const option of CLI_OPTION_NAMES) {
  if (!CLI_HELP_TEXT.includes(option)) failures.push(`CLI help omits declared option ${option}`);
  if (!cliDocumentation.includes(option)) failures.push(`docs/CLI.md omits declared option ${option}`);
}
for (const name of stableTypeExports) {
  if (!new RegExp(`\\b${name}\\b`).test(publicIndexSource)) {
    failures.push(`stable type export ${name} is absent from src/index.ts`);
  }
}

const cli = contract.cli as JsonObject | undefined;
const subcommands = cli?.subcommands as JsonObject | undefined;
if (JSON.stringify(cli?.commands) !== JSON.stringify(CLI_COMMANDS) ||
  JSON.stringify(subcommands?.runs) !== JSON.stringify(CLI_RUNS_COMMANDS) ||
  JSON.stringify(subcommands?.sessions) !== JSON.stringify(CLI_SESSIONS_COMMANDS) ||
  JSON.stringify(subcommands?.changes) !== JSON.stringify(CLI_CHANGES_COMMANDS) ||
  JSON.stringify(subcommands?.state) !== JSON.stringify(CLI_STATE_COMMANDS) ||
  JSON.stringify(cli?.commandOptions) !== JSON.stringify(CLI_COMMAND_OPTION_CONTRACTS) ||
  JSON.stringify(cli?.exitCodes) !== JSON.stringify(CLI_EXIT_CODES)) {
  failures.push("CLI command/subcommand/exit-code contract drifted from contracts/public-api.json");
}
const bins = manifest.bin as JsonObject | undefined;
if (bins?.["zhivex-harness"] !== "./dist/cli.js" || bins?.zhx !== "./dist/zhx.js") {
  failures.push("package binaries drifted from the 1.0 contract");
}
const files = manifest.files;
if (!Array.isArray(files) || !files.includes("contracts")) {
  failures.push("published package must include contracts");
}
const schemas = contract.schemas as JsonObject | undefined;
for (const [key, exportName] of [
  ["config", "HARNESS_CONFIG_SCHEMA_VERSION"],
  ["cliJson", "CLI_JSON_SCHEMA_VERSION"],
  ["cliEvent", "CLI_EVENT_SCHEMA_VERSION"],
  ["operations", "HARNESS_OPERATIONS_SCHEMA_VERSION"],
  ["sessions", "HARNESS_SESSION_SCHEMA_VERSION"],
  ["mcp", "HARNESS_MCP_CONFIG_SCHEMA_VERSION"],
  ["changeEnvelope", "CHANGE_ENVELOPE_SCHEMA_VERSION"],
  ["editContract", "EDIT_CONTRACT_SCHEMA_VERSION"],
  ["stateBackup", "HARNESS_STATE_BACKUP_SCHEMA_VERSION"]
] as const) {
  if (schemas?.[key] !== publicApi[exportName]) failures.push(`schema contract ${key} drifted from ${exportName}`);
}

if (support.schemaVersion !== 1 || support.targetVersion !== "1.0.0") {
  failures.push("support matrix must target schema 1 and version 1.0.0");
}
const entries = Array.isArray(support.entries) ? support.entries as JsonObject[] : [];
const entryIds = entries.map((entry) => entry.id);
if (entries.length === 0 || entryIds.some((id) => typeof id !== "string") || new Set(entryIds).size !== entryIds.length) {
  failures.push("support matrix entries must have unique string IDs");
}
const levels = new Set(["supported", "secondary", "provisional", "unsupported"]);
const dimensions = new Set<string>();
for (const entry of entries) {
  if (typeof entry.dimension === "string") dimensions.add(entry.dimension);
  if (!levels.has(String(entry.level))) failures.push(`support entry ${String(entry.id)} has an invalid level`);
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    failures.push(`support entry ${String(entry.id)} requires evidence`);
  } else {
    for (const evidence of entry.evidence) await existingPath(evidence, `support evidence for ${String(entry.id)}`);
  }
}
for (const required of ["runtime", "operating-system", "version-control", "store", "oci-runtime", "target-package-manager", "mcp-transport", "provider"]) {
  if (!dimensions.has(required)) failures.push(`support matrix is missing ${required}`);
}
for (const provider of publicApi.PROVIDER_DESCRIPTORS) {
  const row = entries.find((entry) => entry.id === `provider-${provider.id}`);
  const expectedLevel = provider.support === "certified" ? "supported" : "provisional";
  if (row?.level !== expectedLevel) failures.push(`provider ${provider.id} support must be ${expectedLevel}`);
}

if (controls.schemaVersion !== 1 || controls.targetVersion !== "1.0.0") {
  failures.push("security controls must target schema 1 and version 1.0.0");
}
const controlRows = Array.isArray(controls.controls) ? controls.controls as JsonObject[] : [];
const threats = controlRows.map((control) => control.threat);
if (controlRows.length === 0 || threats.some((threat) => typeof threat !== "string") || new Set(threats).size !== threats.length) {
  failures.push("security controls must have unique threats");
}
for (const control of controlRows) {
  if (typeof control.residualRisk !== "string" || !control.residualRisk.trim()) {
    failures.push(`security control ${String(control.threat)} requires residual risk`);
  }
  if (!Array.isArray(control.evidence) || control.evidence.length === 0) {
    failures.push(`security control ${String(control.threat)} requires evidence`);
  } else {
    for (const evidence of control.evidence) await existingPath(evidence, `security evidence for ${String(control.threat)}`);
  }
}

if (evaluations.schemaVersion !== 2 || evaluations.targetVersion !== "1.0.0" ||
  JSON.stringify(evaluations.requiredProviders) !== JSON.stringify(GA_REPRESENTATIVE_EVALUATION_PROVIDERS) ||
  JSON.stringify(evaluations.requiredEvidence) !== JSON.stringify(GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE) ||
  JSON.stringify(evaluations.scenarios) !== JSON.stringify(GA_REPRESENTATIVE_EVALUATION_SCENARIOS)) {
  failures.push("representative evaluation matrix must use schema 2 and the certified provider cohort");
}

const migration = readiness.migrationGuarantee as JsonObject | undefined;
if (JSON.stringify(migration?.configSchemas) !== JSON.stringify([4, 5]) ||
  migration?.operationsSchema !== 1 || migration?.sessionSchema !== 1 ||
  migration?.pausedApprovalPolicy !== "original-artifact-only") {
  failures.push("migration guarantee must cover config 4/5, state schema 1, and original-artifact approvals");
}
const historicalFixtureEvidence = exactStringArray(
  migration?.historicalFixtureEvidence,
  "migrationGuarantee.historicalFixtureEvidence"
);
if (migration?.historicalFixtures === "passed" && historicalFixtureEvidence.length === 0) {
  failures.push("passing historical migration fixtures require committed evidence");
}
for (const evidence of historicalFixtureEvidence) {
  await existingPath(evidence, "historical migration fixture evidence");
}
const candidates = Array.isArray(readiness.releaseCandidates) ? readiness.releaseCandidates as JsonObject[] : [];
if (JSON.stringify(candidates.map((candidate) => candidate.version)) !== JSON.stringify(["1.0.0-rc.1", "1.0.0-rc.2"])) {
  failures.push("readiness must require exactly rc.1 and rc.2");
}
for (const candidate of candidates) {
  if (typeof candidate.issue !== "string" || !/^https:\/\/github\.com\/Zhivex\/zhivex-harness\/issues\/\d+$/.test(candidate.issue)) {
    failures.push(`${String(candidate.version)} must link its GitHub issue`);
  }
}
const blockers = Array.isArray(readiness.blockers) ? readiness.blockers as JsonObject[] : [];
if (blockers.length === 0 || new Set(blockers.map((blocker) => blocker.id)).size !== blockers.length) {
  failures.push("readiness blockers must have unique IDs");
}
for (const blocker of blockers) {
  if (!["open", "closed"].includes(String(blocker.status)) ||
    typeof blocker.issue !== "string" || !/^https:\/\/github\.com\/Zhivex\/zhivex-harness\/issues\/\d+$/.test(blocker.issue)) {
    failures.push(`readiness blocker ${String(blocker.id)} must have a valid status and GitHub issue`);
  }
  if (blocker.status === "closed") {
    const evidence = exactStringArray(blocker.evidence, `readiness blocker ${String(blocker.id)} evidence`);
    if (evidence.length === 0) failures.push(`closed readiness blocker ${String(blocker.id)} requires evidence`);
    for (const evidencePath of evidence) {
      await existingPath(evidencePath, `readiness blocker ${String(blocker.id)} evidence`);
    }
  }
}

if (releaseMode) {
  const evidenceMaxAgeDays = readiness.evidenceMaxAgeDays;
  if (!Number.isSafeInteger(evidenceMaxAgeDays) || Number(evidenceMaxAgeDays) < 1 || Number(evidenceMaxAgeDays) > 90) {
    failures.push("GA evidenceMaxAgeDays must be an integer between 1 and 90");
  }
  const maxAgeDays = Number.isSafeInteger(evidenceMaxAgeDays) ? Number(evidenceMaxAgeDays) : 0;
  if (manifest.version !== "1.0.0") failures.push("GA release gate requires package version 1.0.0");
  if (readiness.phase !== "ready") failures.push("GA readiness phase is not ready");
  for (const blocker of blockers) {
    if (blocker.status !== "closed") failures.push(`GA blocker remains open: ${String(blocker.id)}`);
  }
  const parsedCandidates: GaReleaseCandidateEvidence[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = parseGaReleaseCandidateEvidence(candidate);
      if (!evidenceIsCurrent(parsed.publishedAt, maxAgeDays)) {
        failures.push(`${parsed.version} publication evidence is missing, future-dated, or stale`);
      }
      parsedCandidates.push(parsed);
    } catch (error) {
      failures.push(
        `${String(candidate.version)} lacks complete passing release evidence: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (parsedCandidates.length === candidates.length) {
    try {
      assertDistinctGaReleaseCandidateEvidence(parsedCandidates);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    for (const candidate of parsedCandidates) {
      try {
        await verifyPublishedGaReleaseCandidate(candidate);
      } catch (error) {
        failures.push(
          `${candidate.version} published evidence verification failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  const security = readiness.securityReview as JsonObject | undefined;
  if (security?.status !== "passed" || security.criticalFindings !== 0 || security.highFindings !== 0 ||
    !evidenceIsCurrent(security.observedAt, maxAgeDays)) {
    failures.push("GA requires a current passing security review with zero critical/high findings");
  }
  try {
    const securityEvidencePath = parseGaSecurityReviewEvidencePath(security?.evidence);
    await existingPath(securityEvidencePath, "GA security review evidence");
  } catch (error) {
    failures.push(
      `GA security review evidence is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (migration?.historicalFixtures !== "passed") failures.push("historical migration fixtures have not passed");
  if (evaluations.status !== "passed") failures.push("representative evaluation matrix has not passed");
  const results = Array.isArray(evaluations.results) ? evaluations.results as JsonObject[] : [];
  const parsedResults: GaRepresentativeEvaluationResult[] = [];
  if (parsedCandidates.length === candidates.length) {
    try {
      parsedResults.push(...parseGaRepresentativeEvaluationCoverage(
        parsedCandidates,
        results,
        evaluations.requiredEvidence,
        evaluations.scenarios
      ));
      await verifyGaRepresentativeEvaluationWorkflows(parsedCandidates, parsedResults);
    } catch (error) {
      failures.push(
        `representative evaluation coverage is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  for (const result of parsedResults) {
    if (!evidenceIsCurrent(result.observedAt, maxAgeDays)) {
      failures.push(`${result.releaseTag}/${result.provider} evaluation evidence is missing, future-dated, or stale`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`1.0 readiness check failed:\n- ${failures.join("\n- ")}`);
}

const openBlockers = blockers.filter((blocker) => blocker.status !== "closed").length;
process.stdout.write(
  releaseMode
    ? "1.0 GA release readiness passed.\n"
    : `1.0 preparation contract passed; ${openBlockers} GA blockers remain explicitly open.\n`
);
