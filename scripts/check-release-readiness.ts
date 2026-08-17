import { readFile } from "node:fs/promises";
import path from "node:path";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  license?: string;
  repository?: { type?: string; url?: string };
  bugs?: { url?: string };
  homepage?: string;
  publishConfig?: { access?: string; provenance?: boolean; registry?: string };
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
  engines?: { bun?: string };
  packageManager?: string;
}

const workspace = path.resolve(import.meta.dir, "..");

const run = async (command: string[], allowFailure = false): Promise<CommandResult> => {
  const child = Bun.spawn(command, {
    cwd: workspace,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${stdout}\n${stderr}`);
  }
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
};

const optionValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const registryCheckRequested = process.argv.includes("--registry");
const requestedTag = optionValue("--tag");
const failures: string[] = [];
const manifest = JSON.parse(
  await readFile(path.join(workspace, "package.json"), "utf8")
) as PackageManifest;

if (manifest.name !== "@zhivex-ai/harness") {
  failures.push("package name must be @zhivex-ai/harness");
}
if (!manifest.version || !/^0\.5\.\d+$/.test(manifest.version)) {
  failures.push("package version must be a stable 0.5.x version");
}
if (manifest.private === true) {
  failures.push("package.json is still private");
}
if (!manifest.description?.trim()) {
  failures.push("package description is required");
}
if (manifest.license !== "MIT") {
  failures.push("package license must be MIT");
}
if (
  manifest.repository?.type !== "git" ||
  manifest.repository.url !== "git+https://github.com/Zhivex/zhivex-harness.git"
) {
  failures.push("repository metadata must exactly match the GitHub source repository");
}
if (manifest.bugs?.url !== "https://github.com/Zhivex/zhivex-harness/issues") {
  failures.push("bugs metadata must point to the GitHub issue tracker");
}
if (manifest.homepage !== "https://github.com/Zhivex/zhivex-harness#readme") {
  failures.push("homepage metadata must point to the repository README");
}
if (
  manifest.publishConfig?.access !== "public" ||
  manifest.publishConfig.provenance !== true ||
  manifest.publishConfig.registry !== "https://registry.npmjs.org/"
) {
  failures.push("publishConfig must require public npm access, provenance, and the npmjs registry");
}
if (manifest.bin?.["zhivex-harness"] !== "./dist/cli.js") {
  failures.push("the packaged CLI binary is missing or points at the wrong file");
}
if (!manifest.exports?.["."]) {
  failures.push("the public root library export is missing");
}
for (const requiredFile of [
  "dist",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "SUPPORT.md",
  "docs",
  "evaluations",
  "examples"
]) {
  if (!manifest.files?.includes(requiredFile)) {
    failures.push(`package files are missing ${requiredFile}`);
  }
}
if (manifest.engines?.bun !== ">=1.3.7" || manifest.packageManager !== "bun@1.3.7") {
  failures.push("Bun engine and package-manager metadata must remain pinned to the release baseline");
}
if (!manifest.scripts?.["release:check"]?.includes("check-release-readiness.ts")) {
  failures.push("package scripts do not expose the release readiness gate");
}
if (!manifest.scripts?.["artifact:check"] || !manifest.scripts?.["smoke:artifact"]) {
  failures.push("package scripts do not expose exact-artifact inspection and installation gates");
}

const changelog = await readFile(path.join(workspace, "CHANGELOG.md"), "utf8");
if (manifest.version) {
  const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const datedRelease = changelog.match(new RegExp(`^## ${escapedVersion} - (\\d{4}-\\d{2}-\\d{2})$`, "m"));
  if (!datedRelease) {
    failures.push(`CHANGELOG.md must include an ISO-dated ${manifest.version} release heading`);
  } else if (Number.isNaN(Date.parse(`${datedRelease[1]}T00:00:00Z`))) {
    failures.push(`CHANGELOG.md has an invalid release date for ${manifest.version}`);
  }
  if (changelog.includes(`## ${manifest.version} - Unreleased`)) {
    failures.push(`CHANGELOG.md still marks ${manifest.version} as unreleased`);
  }
}

const releaseWorkflow = await readFile(
  path.join(workspace, ".github", "workflows", "release.yml"),
  "utf8"
);
for (const required of [
  "workflow_dispatch:",
  "id-token: write",
  "environment: npm",
  "package-manager-cache: false",
  "bun install --frozen-lockfile --ignore-scripts",
  "bun run release:check",
  "bun pm pack",
  "bun run artifact:check",
  "bun run smoke:artifact",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "(cd release-artifacts && shasum -a 512 -c SHA512SUMS)",
  'npm publish "./$ARTIFACT" --access public --provenance --tag "$RELEASE_CHANNEL"',
  'bun run release:status -- "$ARTIFACT"',
  'bun run release:verify -- "$ARTIFACT" "$RELEASE_CHANNEL"'
]) {
  if (!releaseWorkflow.includes(required)) {
    failures.push(`release workflow is missing: ${required}`);
  }
}

const status = await run(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
if (status.stdout) {
  failures.push("Git worktree is not clean");
}

const head = await run(["git", "rev-parse", "HEAD"]);
const branch = await run(["git", "branch", "--show-current"]);
if (process.env.GITHUB_ACTIONS !== "true" && branch.stdout !== "main") {
  failures.push(`release checks must run from main, not ${branch.stdout || "detached HEAD"}`);
}

if (requestedTag) {
  if (requestedTag !== `v${manifest.version}`) {
    failures.push(`release tag ${requestedTag} does not match package version ${manifest.version}`);
  } else {
    const tagType = await run(["git", "cat-file", "-t", requestedTag], true);
    if (tagType.exitCode !== 0) {
      failures.push(`release tag ${requestedTag} does not exist in the checkout`);
    } else if (tagType.stdout !== "tag") {
      failures.push(`release tag ${requestedTag} must be annotated`);
    }
    const tagCommit = await run(["git", "rev-list", "-n", "1", requestedTag], true);
    if (tagCommit.exitCode === 0 && tagCommit.stdout !== head.stdout) {
      failures.push(`release tag ${requestedTag} does not resolve to HEAD`);
    }
  }
}

if (process.env.GITHUB_ACTIONS === "true") {
  if (process.env.GITHUB_REPOSITORY !== "Zhivex/zhivex-harness") {
    failures.push("release workflow is running outside Zhivex/zhivex-harness");
  }
  if (process.env.GITHUB_SHA !== head.stdout) {
    failures.push("release tag checkout does not match the workflow-dispatch commit on main");
  }
  const mainAncestor = await run(
    ["git", "merge-base", "--is-ancestor", head.stdout, "origin/main"],
    true
  );
  if (mainAncestor.exitCode !== 0) {
    failures.push("release commit is not reachable from origin/main");
  }
}

if (registryCheckRequested && manifest.name && manifest.version) {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`;
  try {
    const response = await fetch(registryUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 404) {
      // Expected for the first release of a new package.
    } else if (!response.ok) {
      failures.push(`npm registry readiness request failed with HTTP ${response.status}`);
    } else {
      const document = await response.json() as { versions?: Record<string, unknown> };
      if (document.versions?.[manifest.version]) {
        failures.push(`${manifest.name}@${manifest.version} already exists and cannot be republished`);
      }
    }
  } catch (error) {
    failures.push(`npm registry readiness request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Release readiness check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(
  `Release readiness passed for ${manifest.name}@${manifest.version} at ${head.stdout.slice(0, 12)}${requestedTag ? ` (${requestedTag})` : ""}.\n`
);
