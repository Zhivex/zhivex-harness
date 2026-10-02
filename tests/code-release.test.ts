import { expect, test } from "bun:test";
import { assertCodeManifest, assertCodeRegistryState, assertCodeReleaseIdentity, assertCodeProvenance, codeReleaseChannel, assertCodeReleaseChannel } from "../scripts/code-release.js";
import manifest from "../packages/code/package.json";
import { readFile } from "node:fs/promises";

const sha = "a".repeat(40);
function identity(overrides: Partial<Parameters<typeof assertCodeReleaseIdentity>[0]> = {}) {
  return {
    version: manifest.version, channel: codeReleaseChannel(manifest.version), tag: `code-v${manifest.version}`, sha, ref: `refs/tags/code-v${manifest.version}`, repository: "Zhivex/zhivex-harness",
    run: (command: string[]) => command[1] === "cat-file" ? "tag" : ["rev-parse", "rev-list"].includes(command[1]!) ? sha : "",
    api: async () => ({ workflow_runs: [{ head_sha: sha, status: "completed", conclusion: "success" }] }), ...overrides,
  };
}
test("Code release requires matching channel, exact stable engine, unique binary, no install hooks", () => {
  assertCodeManifest(manifest);
  for (const change of [{ private: true }, { version: "0.1.0-rc.1" }, { dependencies: { "@zhivex-ai/harness": "^1.3.0" } }, { dependencies: { "@zhivex-ai/harness": "1.3.0-rc.7" } }, { dependencies: { "@zhivex-ai/harness": "1.03.0" } }, { bin: { zhx: "./dist/cli.js" } }, { scripts: { postinstall: "build" } }, { publishConfig: { access: "public", registry: "https://registry.npmjs.org/", tag: "next" } }]) {
    expect(() => assertCodeManifest({ ...manifest, ...change })).toThrow();
  }
});
test("Code preserves RC/next and rejects noncanonical versions and channel drift", () => {
  for (const engine of ["1.3.0-rc.7", "1.3.0"]) {
    assertCodeManifest({ ...manifest, version: "0.1.0-rc.3", dependencies: { "@zhivex-ai/harness": engine }, publishConfig: { ...manifest.publishConfig, tag: "next" } });
  }
  expect(codeReleaseChannel("0.1.0")).toBe("latest");
  expect(codeReleaseChannel("0.1.0-rc.3")).toBe("next");
  for (const version of ["0.01.0", "0.1.0-rc.0", "0.1.0-rc.01", "0.1.0-beta.1", "0.1.0+build", "1.0.0", "0.9007199254740992.0", "0.1.0-rc.9007199254740992"]) expect(() => codeReleaseChannel(version)).toThrow();
  expect(() => assertCodeReleaseChannel("0.1.0", "next")).toThrow();
  expect(() => assertCodeReleaseChannel("0.1.0-rc.3", "latest")).toThrow();
});
test("Code release refuses mismatched refs, commits, forks, unreviewed or failed CI", async () => {
  await assertCodeReleaseIdentity(identity());
  for (const change of [{ channel: "next" }, { ref: "refs/heads/main" }, { repository: "fork/harness" }, { tag: "v0.1.0-rc.1" }, { sha: "b".repeat(40) }, { api: async () => ({ workflow_runs: [] }) }, { api: async () => ({ workflow_runs: [{ head_sha: sha, status: "completed", conclusion: "failure" }] }) }, { run: () => "commit" }]) {
    await expect(assertCodeReleaseIdentity(identity(change))).rejects.toThrow();
  }
  await expect(assertCodeReleaseIdentity(identity({ run: command => { if (command[1] === "merge-base") throw new Error("not on main"); return identity().run(command); } }))).rejects.toThrow();
  await expect(assertCodeReleaseIdentity(identity({ run: command => command[1] === "status" ? " M package.json" : identity().run(command) }))).rejects.toThrow();
});
test("Stable registry channel permits promotion from initial RC latest without consulting next", () => {
  expect(assertCodeRegistryState({ "dist-tags": { latest: "0.1.0-rc.1", next: "0.2.0-rc.9" } }, "0.1.0", "sha512-abc")).toBe("absent");
  for (const latest of ["0.1.1", "0.2.0", "0.10.0", "1.0.0", "0.01.0", "broken"]) {
    expect(() => assertCodeRegistryState({ "dist-tags": { latest } }, "0.1.0", "sha512-abc")).toThrow();
  }
  expect(assertCodeRegistryState({ "dist-tags": { latest: "0.9.0" } }, "0.10.0", "sha512-abc")).toBe("absent");
  expect(() => assertCodeRegistryState({ "dist-tags": { next: "0.10.0-rc.1" } }, "0.9.0-rc.2", "sha512-abc")).toThrow();
  expect(assertCodeRegistryState({ "dist-tags": { next: "0.1.0-rc.9" } }, "0.1.0-rc.10", "sha512-abc")).toBe("absent");
  const versions = { "0.1.0": { name: manifest.name, version: "0.1.0", dist: { integrity: "sha512-abc" } } };
  expect(assertCodeRegistryState({ versions, "dist-tags": { latest: "0.1.0" } }, "0.1.0", "sha512-abc")).toBe("identical");
  expect(() => assertCodeRegistryState({ versions, "dist-tags": { latest: "0.2.0" } }, "0.1.0", "sha512-abc")).toThrow("older");
});
test("Code workflow validates channel before registry reads and publishes retained bytes through protected OIDC", async () => {
  const workflow = Bun.YAML.parse(await readFile(new URL("../.github/workflows/release-code.yml", import.meta.url), "utf8")) as any;
  expect(workflow.on.workflow_dispatch.inputs.channel.options).toEqual(["latest", "next"]);
  expect(workflow.env.RELEASE_CHANNEL).toBe("${{ inputs.channel }}");
  const validate = workflow.jobs.validate.steps;
  expect(validate.findIndex((s: any) => s.run === "bun run scripts/code-release.ts identity")).toBeLessThan(validate.findIndex((s: any) => s.run?.includes("code-release.ts engine")));
  expect(validate.some((s: any) => s.run === "bun run scripts/code-release.ts smoke-registry release-code-artifacts/code.tgz")).toBe(true);
  const publish = workflow.jobs.publish;
  expect(publish.environment).toBe("npm");
  expect(publish.permissions["id-token"]).toBe("write");
  expect(publish.needs).toBe("validate");
  expect(publish.if).toContain("inputs.confirm_publication");
  const publication = publish.steps.find((s: any) => s.run?.includes(" publish "));
  expect(publication.if).toBe("steps.registry.outputs.status == 'absent'");
  expect(publication.run).toContain('publish ./release-code-artifacts/code.tgz --ignore-scripts --access public --provenance --tag "$RELEASE_CHANNEL"');
  expect(publish.steps.some((s: any) => s.run?.includes("shasum -a 512 -c SHA512SUMS"))).toBe(true);
  expect(publish.steps.some((s: any) => s.run?.includes("code-release.ts verify"))).toBe(true);
  expect(publish.steps.some((s: any) => /bun (?:pm pack|run build)/.test(s.run ?? ""))).toBe(false);
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
