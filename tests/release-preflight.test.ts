import { expect, test } from "bun:test";
import { loadReleaseMetadata, validateReleaseMetadata, type ReleaseMetadata } from "../scripts/release-preflight.js";
import { prepareRelease, type Command } from "../scripts/prepare-release.js";
import { bundledDefaultModel } from "../src/models/catalog.js";
import path from "node:path";

test("RC certification selects Flash without changing historical pins or user defaults", async () => {
  const input = await loadReleaseMetadata(path.resolve(import.meta.dir, ".."));
  validateReleaseMetadata(input, false, "next");
  expect(input.version).toBe("1.2.0-rc.1");
  expect(input.matrix.expectedModels.find(row => row.releaseTag === `v${input.version}`)?.models)
    .toEqual({meta: "muse-spark-1.3", qwen: "qwen3.8-flash", openai: "gpt-6-luna"});
  expect(input.matrix.expectedModels.find(row => row.releaseTag === "v1.1.4")?.models.qwen).toBe("qwen3.8-max");
  expect(bundledDefaultModel("qwen")).toBe("qwen3.8-max");
});

function metadata(): ReleaseMetadata {
  return {
    version: "1.1.0-rc.3", changelog: "## 1.1.0-rc.3 - 2026-09-22",
    matrix: { releaseTags: ["v1.1.0-rc.3"], expectedModels: [{ releaseTag: "v1.1.0-rc.3", models: { meta: "m", qwen: "q", openai: "o" } }] },
    workflow: { jobs: { "certify-live": { env: { ZHIVEX_HARNESS_LIVE_META_MODEL: "m", ZHIVEX_HARNESS_LIVE_QWEN_MODEL: "q", ZHIVEX_HARNESS_LIVE_OPENAI_MODEL: "o" } }, "representative-evaluation": { steps: [["meta", "m"], ["qwen", "q"], ["openai", "o"]].map(([provider, model]) => ({ id: `representative_${provider}`, env: { ZHIVEX_SAFE_FIX_PROVIDER: provider!, ZHIVEX_SAFE_FIX_MODEL: model! }, run: `evidence --provider ${provider} --model ${model} > report` })) } } }
  };
}
test("dated candidate binds channel and all representative models", () => {
  expect(() => validateReleaseMetadata(metadata(), false, "next")).not.toThrow();
  expect(() => validateReleaseMetadata(metadata(), false, "latest")).toThrow("must use npm channel next");
  const input = metadata(); input.matrix.expectedModels[0]!.models.qwen = "stale";
  expect(() => validateReleaseMetadata(input)).toThrow("qwen");
});
test("development permits Unreleased but publication rejects it", () => {
  const input = metadata(); input.changelog = "## 1.1.0-rc.3 - Unreleased"; input.matrix.releaseTags = [];
  expect(() => validateReleaseMetadata(input, true)).not.toThrow();
  expect(() => validateReleaseMetadata(input)).toThrow("Unreleased");
});
test("invalid calendar dates and missing certification mappings fail even in CI", () => {
  const input = metadata(); input.changelog = "## 1.1.0-rc.3 - 2026-02-30";
  expect(() => validateReleaseMetadata(input, true)).toThrow("Invalid release date");
  input.changelog = metadata().changelog; input.matrix.releaseTags = [];
  expect(() => validateReleaseMetadata(input, true)).toThrow("must authorize");
});

const sha = "a".repeat(40);
function fixture(options: { ci?: string; tagSha?: string; drift?: boolean; active?: boolean } = {}) {
  const calls: string[][] = [];
  let mainReads = 0;
  const run: Command = async args => {
    calls.push(args);
    if (args[0] === "git") return args[1] === "status" ? "" : sha;
    if (args[0] === "bun" || args[1] === "workflow") return "";
    const endpoint = args[2]!;
    if (endpoint.endsWith("commits/main")) return JSON.stringify({ sha: options.drift && ++mainReads > 1 ? "b".repeat(40) : sha });
    if (endpoint.includes("actions/workflows")) return JSON.stringify({ workflow_runs: endpoint.includes("release.yml") ? (options.active ? [{ status: "in_progress" }] : []) : [{ head_sha: sha, status: "completed", conclusion: options.ci ?? "success" }] });
    if (endpoint.includes("matching-refs")) return JSON.stringify(options.tagSha ? [{ ref: "refs/tags/v1.1.0-rc.3", object: { type: "tag", sha: "tag-object" } }] : []);
    if (endpoint.includes("git/tags/")) return JSON.stringify({ tag: "v1.1.0-rc.3", object: { type: "commit", sha: options.tagSha ?? sha } });
    if (endpoint.includes("git/ref/")) return JSON.stringify({ object: { type: "tag", sha: "tag-object" } });
    return JSON.stringify({ sha: "tag-object" });
  };
  return { calls, run };
}
test("dry run performs no remote mutation", async () => {
  const f = fixture(); await prepareRelease({ sha, version: "1.1.0-rc.3", publish: false, run: f.run });
  expect(f.calls.some(args => args.includes("POST") || args[1] === "workflow")).toBe(false);
});
test("publication creates annotated tag then dispatches exact tag, never forces refs", async () => {
  const f = fixture(); await prepareRelease({ sha, version: "1.1.0-rc.3", publish: true, run: f.run });
  const writes = f.calls.filter(args => args.includes("POST"));
  expect(writes.map(args => args[2])).toEqual(["repos/Zhivex/zhivex-harness/git/tags", "repos/Zhivex/zhivex-harness/git/refs"]);
  expect(f.calls.at(-1)).toContain("v1.1.0-rc.3");
  expect(f.calls.at(-1)).toContain("channel=next");
  expect(f.calls.flat().some(arg => arg.includes("force"))).toBe(false);
});
for (const [name, options] of Object.entries({ "failed CI": { ci: "failure" }, "conflicting tag": { tagSha: "b".repeat(40) }, "main moved": { drift: true }, "active release": { active: true } })) {
  test(`${name} blocks every mutation`, async () => {
    const f = fixture(options);
    await expect(prepareRelease({ sha, version: "1.1.0-rc.3", publish: true, run: f.run })).rejects.toThrow();
    expect(f.calls.some(args => args.includes("POST") || args[1] === "workflow")).toBe(false);
  });
}
test("same annotated tag supports recovery without recreating it", async () => {
  const f = fixture({ tagSha: sha }); await prepareRelease({ sha, version: "1.1.0-rc.3", publish: true, run: f.run });
  expect(f.calls.some(args => args.includes("POST"))).toBe(false);
  expect(f.calls.at(-1)?.[1]).toBe("workflow");
});

test("release rejects divergent live and representative certification models", () => {
  const input = metadata();
  input.workflow.jobs["certify-live"]!.env!.ZHIVEX_HARNESS_LIVE_QWEN_MODEL = "other";
  expect(() => validateReleaseMetadata(input)).toThrow("Live workflow model disagrees");
});
