import { expect, test } from "bun:test";
import { assertCodeManifest, assertCodeRegistryState, assertCodeReleaseIdentity, assertCodeProvenance } from "../scripts/code-release.js";
import manifest from "../packages/code/package.json";

const sha = "a".repeat(40);
function identity(overrides: Partial<Parameters<typeof assertCodeReleaseIdentity>[0]> = {}) {
  return {
    version: manifest.version, tag: `code-v${manifest.version}`, sha, ref: `refs/tags/code-v${manifest.version}`, repository: "Zhivex/zhivex-harness",
    run: (command: string[]) => command[1] === "cat-file" ? "tag" : ["rev-parse", "rev-list"].includes(command[1]!) ? sha : "",
    api: async () => ({ workflow_runs: [{ head_sha: sha, status: "completed", conclusion: "success" }] }), ...overrides,
  };
}
test("Code candidate requires exact engine, next, unique binary, no install hooks", () => {
  assertCodeManifest(manifest);
  for (const change of [{ private: true }, { version: "0.1.0" }, { dependencies: { "@zhivex-ai/harness": "^1.3.0" } }, { bin: { zhx: "./dist/cli.js" } }, { scripts: { postinstall: "build" } }, { publishConfig: { access: "public", registry: "https://registry.npmjs.org/", tag: "latest" } }]) {
    expect(() => assertCodeManifest({ ...manifest, ...change })).toThrow();
  }
});
test("Code release refuses mismatched refs, commits, forks, unreviewed or failed CI", async () => {
  await assertCodeReleaseIdentity(identity());
  for (const change of [{ ref: "refs/heads/main" }, { repository: "fork/harness" }, { tag: "v0.1.0-rc.1" }, { sha: "b".repeat(40) }, { api: async () => ({ workflow_runs: [] }) }, { api: async () => ({ workflow_runs: [{ head_sha: sha, status: "completed", conclusion: "failure" }] }) }, { run: () => "commit" }]) {
    await expect(assertCodeReleaseIdentity(identity(change))).rejects.toThrow();
  }
  await expect(assertCodeReleaseIdentity(identity({ run: command => { if (command[1] === "merge-base") throw new Error("not on main"); return identity().run(command); } }))).rejects.toThrow();
  await expect(assertCodeReleaseIdentity(identity({ run: command => command[1] === "status" ? " M package.json" : identity().run(command) }))).rejects.toThrow();
});
test("Registry retries accept only identical immutable artifacts", () => {
  expect(assertCodeRegistryState({}, manifest.version, "sha512-abc")).toBe("absent");
  const document = { versions: { [manifest.version]: { name: manifest.name, version: manifest.version, dist: { integrity: "sha512-abc" } } } };
  expect(assertCodeRegistryState(document, manifest.version, "sha512-abc")).toBe("identical");
  expect(() => assertCodeRegistryState(document, manifest.version, "sha512-other")).toThrow();
  expect(() => assertCodeRegistryState({ "dist-tags": { next: "0.1.0-rc.2" } }, "0.1.0-rc.1", "sha512-abc")).toThrow("older");
  expect(assertCodeRegistryState({ "dist-tags": { next: "0.1.0-rc.1" } }, "0.1.0-rc.2", "sha512-abc")).toBe("absent");
  expect(() => assertCodeRegistryState({ "dist-tags": { next: "0.1.0" } }, "0.1.0-rc.2", "sha512-abc")).toThrow("order");
});
test("Code provenance rejects another workflow, ref, commit or artifact", () => {
  const statement = { subject: [{ digest: { sha512: "digest" } }], predicate: { buildDefinition: { externalParameters: { workflow: { repository: "https://github.com/Zhivex/zhivex-harness", path: ".github/workflows/release-code.yml", ref: `refs/tags/code-v${manifest.version}` } }, resolvedDependencies: [{ digest: { gitCommit: sha } }] }, runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" }, metadata: { invocationId: "https://github.com/Zhivex/zhivex-harness/actions/runs/123" } } } };
  assertCodeProvenance(statement, "digest", manifest.version, sha);
  expect(() => assertCodeProvenance(statement, "other", manifest.version, sha)).toThrow();
  expect(() => assertCodeProvenance(statement, "digest", manifest.version, "b".repeat(40))).toThrow();
  statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/release.yml";
  expect(() => assertCodeProvenance(statement, "digest", manifest.version, sha)).toThrow();
});

test("Bootstrap provenance generation rejects local, fork and PR contexts", () => {
  const { validateBuildIdentity } = require("../scripts/code-bootstrap-provenance.cjs");
  expect(() => validateBuildIdentity(manifest, {})).toThrow();
  expect(() => validateBuildIdentity(manifest, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "fork/harness" })).toThrow();
  expect(() => validateBuildIdentity(manifest, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Zhivex/zhivex-harness", GITHUB_EVENT_NAME: "pull_request" })).toThrow();
});
