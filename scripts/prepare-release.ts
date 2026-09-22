import path from "node:path";
import { loadReleaseMetadata, validateReleaseMetadata } from "./release-preflight.js";
import { parseHarnessReleaseVersion } from "./release-policy.js";

const repository = "Zhivex/zhivex-harness";
export type Command = (args: string[]) => Promise<string>;

// All commands use argument arrays: no shell interpolation of release metadata.
export async function prepareRelease(options: {
  sha: string; version: string; publish: boolean; run: Command;
}): Promise<void> {
  const { sha, version, publish, run } = options;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("--sha requires a full lowercase commit SHA");
  const { tag, channel } = parseHarnessReleaseVersion(version);
  const api = async (endpoint: string, args: string[] = []) => JSON.parse(await run(["gh", "api", `repos/${repository}/${endpoint}`, ...args]));
  if ((await run(["git", "status", "--porcelain=v1", "--untracked-files=all"])).trim()) throw new Error("Use a clean checkout");
  if ((await run(["git", "rev-parse", "HEAD"])).trim() !== sha) throw new Error("Checkout differs from requested SHA");
  if ((await api("commits/main")).sha !== sha) throw new Error("Requested SHA must be current remote main");
  // Includes registry absence, dated changelog, release policy and clean/main checkout.
  await run(["bun", "run", "scripts/check-release-readiness.ts", "--channel", channel, "--registry"]);
  for (const workflow of ["ci.yml", "codeql.yml"]) {
    const response = await api(`actions/workflows/${workflow}/runs?head_sha=${sha}&branch=main&event=push&per_page=100`);
    const latest = response.workflow_runs?.[0];
    if (latest?.head_sha !== sha || latest?.status !== "completed" || latest?.conclusion !== "success") {
      throw new Error(`${workflow} must pass on ${sha} (latest push run)`);
    }
  }
  const releases = await api(`actions/workflows/release.yml/runs?head_sha=${sha}&per_page=100`);
  if (releases.workflow_runs?.some((run: { status: string }) => run.status !== "completed")) {
    throw new Error("A release is already active for this SHA");
  }
  const refs = await api(`git/matching-refs/tags/${tag}`);
  const existing = refs.find((ref: { ref: string }) => ref.ref === `refs/tags/${tag}`);
  if (existing) {
    if (existing.object.type !== "tag") throw new Error("Existing release tag is not annotated");
    const annotated = await api(`git/tags/${existing.object.sha}`);
    if (annotated.tag !== tag || annotated.object.type !== "commit" || annotated.object.sha !== sha) {
      throw new Error("Existing tag targets another commit; it will not be moved");
    }
  }
  if (!publish) return;
  if ((await api("commits/main")).sha !== sha) throw new Error("main changed during preflight; restart preparation");
  if (!existing) {
    const annotated = await api("git/tags", ["--method", "POST", "-f", `tag=${tag}`, "-f", `message=Release ${tag} to ${channel}`, "-f", `object=${sha}`, "-f", "type=commit"]);
    // Creation is atomic; an existing concurrent ref is never overwritten.
    await api("git/refs", ["--method", "POST", "-f", `ref=refs/tags/${tag}`, "-f", `sha=${annotated.sha}`]);
  }
  const current = await api(`git/ref/tags/${tag}`);
  if (current.object.type !== "tag") throw new Error("Tag changed before dispatch");
  const target = await api(`git/tags/${current.object.sha}`);
  if (target.object.type !== "commit" || target.object.sha !== sha) throw new Error("Tag changed before dispatch");
  // Dispatch the exact tag so a concurrent main update cannot select another commit.
  await run(["gh", "workflow", "run", "release.yml", "--repo", repository, "--ref", tag,
    "-f", `tag=${tag}`, "-f", `channel=${channel}`, "-f", "confirm_publication=true"]);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "--sha" || !args[1] || args.length > 3 || (args[2] !== undefined && args[2] !== "--publish")) {
    throw new Error("Usage: bun run release:prepare --sha <full-main-sha> [--publish] (default: read-only preflight)");
  }
  const root = path.resolve(import.meta.dir, "..");
  const metadata = await loadReleaseMetadata(root);
  validateReleaseMetadata(metadata);
  await prepareRelease({ sha: args[1], version: metadata.version, publish: args.includes("--publish"), run: async command => {
    const child = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed (${code}): ${stderr}`);
    return stdout.trim();
  } });
  console.log(args.includes("--publish") ? "Release dispatched; publication remains subject to all protected gates." : "Preflight passed. No tag created or workflow dispatched. Repeat with --publish to confirm publication.");
}
