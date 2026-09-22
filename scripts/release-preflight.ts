import { readFile } from "node:fs/promises";
import path from "node:path";
import { findReleaseChangelogHeading } from "./release-changelog.js";
import { assertHarnessReleaseChannel, parseHarnessReleaseVersion } from "./release-policy.js";

export interface ReleaseMetadata {
  version: string;
  changelog: string;
  matrix: { releaseTags: string[]; expectedModels: { releaseTag: string; models: Record<string, string> }[] };
  workflow: { jobs: Record<string, { steps?: { id?: string; run?: string; env?: Record<string, string> }[] }> };
}

export function validateReleaseMetadata(input: ReleaseMetadata, allowUnreleased = false, channel?: string): void {
  const release = parseHarnessReleaseVersion(input.version);
  if (channel !== undefined) assertHarnessReleaseChannel(input.version, channel);
  const heading = findReleaseChangelogHeading(input.changelog, input.version);
  if (!heading) throw new Error(`Missing changelog heading for ${input.version}`);
  if (heading.kind === "unreleased") {
    if (!allowUnreleased) throw new Error(`${input.version} is Unreleased; date the changelog before creating a tag`);
    return;
  }
  const date = new Date(`${heading.value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== heading.value) {
    throw new Error(`Invalid release date: ${heading.value}`);
  }
  const rows = input.matrix.expectedModels.filter(row => row.releaseTag === release.tag);
  if (!input.matrix.releaseTags.includes(release.tag) || rows.length !== 1) {
    throw new Error(`Representative matrix must authorize ${release.tag} with exactly one model mapping`);
  }
  for (const provider of ["meta", "qwen", "openai"]) {
    const model = rows[0]!.models[provider];
    const step = input.workflow.jobs["representative-evaluation"]?.steps?.find(step => step.id === `representative_${provider}`);
    if (!model || step?.env?.ZHIVEX_SAFE_FIX_PROVIDER !== provider || step.env.ZHIVEX_SAFE_FIX_MODEL !== model ||
        !step.run?.includes(`--provider ${provider} --model ${model} `)) {
      throw new Error(`Representative workflow model disagrees with ${release.tag}: ${provider}`);
    }
  }
}

export async function loadReleaseMetadata(root: string): Promise<ReleaseMetadata> {
  const [manifest, changelog, matrix, workflow] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"), readFile(path.join(root, "CHANGELOG.md"), "utf8"),
    readFile(path.join(root, "evaluations/representative-assembly-matrix.json"), "utf8"),
    readFile(path.join(root, ".github/workflows/release.yml"), "utf8")
  ]);
  return { version: JSON.parse(manifest).version, changelog, matrix: JSON.parse(matrix), workflow: Bun.YAML.parse(workflow) as ReleaseMetadata["workflow"] };
}

if (import.meta.main) {
  const input = await loadReleaseMetadata(path.resolve(import.meta.dir, ".."));
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--allow-unreleased")) throw new Error("Usage: release:preflight [--allow-unreleased]");
  validateReleaseMetadata(input, args.includes("--allow-unreleased"));
  console.log(`Release metadata passed for ${input.version}`);
}
