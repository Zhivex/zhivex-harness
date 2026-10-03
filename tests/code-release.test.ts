import { expect, test } from "bun:test";
import { assertCodeManifest, assertCodeRegistryState, assertCodeReleaseIdentity, assertCodeProvenance, codeReleaseChannel, assertCodeReleaseChannel, inspectCodeArtifact, assertCodePayload } from "../scripts/code-release.js";
import manifest from "../packages/code/package.json";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

test("Code artifact accepts the two shipped offline examples and binds exact bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-pack-regression-"));
  try {
    const files = {
      "package/package.json": JSON.stringify(manifest), "package/README.md": "Code\n", "package/LICENSE": "MIT\n",
      "package/CHANGELOG.md": "Code changes\n",
      "package/dist/cli.js": "#!/usr/bin/env node\n", "package/dist/chunk-abc123.js": "export {};\n",
      "package/examples/first-use.mjs": "export {};\n", "package/examples/offline-provider.mjs": "export {};\n",
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), content);
    }
    const artifact = path.join(directory, "code.tgz");
    const packed = spawnSync("tar", ["-czf", artifact, "-C", directory, ...Object.keys(files)], { encoding: "utf8" });
    expect(packed.status).toBe(0);
    const digest = createHash("sha512").update(await readFile(artifact)).digest("hex");
    expect(await inspectCodeArtifact(artifact, manifest)).toEqual({
      sha512Hex: digest, integrity: `sha512-${Buffer.from(digest, "hex").toString("base64")}`,
    });
    await rm(path.join(directory, "package/examples/offline-provider.mjs"));
    await symlink("../dist/cli.js", path.join(directory, "package/examples/offline-provider.mjs"));
    expect(spawnSync("tar", ["-czf", artifact, "-C", directory, ...Object.keys(files)]).status).toBe(0);
    await expect(inspectCodeArtifact(artifact, manifest)).rejects.toThrow("regular files");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Code payload rejects arbitrary examples, source, secrets, traversal, nested output and duplicates", () => {
  const required = ["package/package.json", "package/README.md", "package/CHANGELOG.md", "package/LICENSE", "package/dist/cli.js",
    "package/examples/first-use.mjs", "package/examples/offline-provider.mjs"];
  assertCodePayload([...required, "package/", "package/dist/", "package/examples/", "package/dist/chunk-abc123.js"]);
  for (const unexpected of ["package/examples/other.mjs", "package/examples/.env", "package/examples/nested/first-use.mjs",
    "package/src/cli.ts", "package/dist/cli.js.map", "package/dist/.hidden.js", "package/dist/nested/cli.js",
    "package/dist/../secret.js", "package/../secret", "/package/dist/cli.js", "package/dist/cliXjs", "package/README.md.bak"]) {
    expect(() => assertCodePayload([...required, unexpected])).toThrow("Unexpected Code payload");
  }
  for (const missing of required) expect(() => assertCodePayload(required.filter(name => name !== missing))).toThrow("Missing");
  expect(() => assertCodePayload([...required, required[0]!])).toThrow("Duplicate");
});

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
test("Code identity requires the latest installed journeys for the exact main SHA", async () => {
  const queried: string[] = [];
  await assertCodeReleaseIdentity(identity({ api: async endpoint => {
    queried.push(endpoint);
    return identity().api("");
  } }));
  expect(queried).toContain(`actions/workflows/code-journey.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`);
  for (const result of [[], [{ head_sha: "b".repeat(40), status: "completed", conclusion: "success" }],
    [{ head_sha: sha, status: "in_progress", conclusion: "" }], [{ head_sha: sha, status: "completed", conclusion: "failure" }],
    [{ head_sha: sha, status: "completed", conclusion: "failure" }, ...((await identity().api("")).workflow_runs!)]]) {
    await expect(assertCodeReleaseIdentity(identity({ api: async endpoint => endpoint.includes("code-journey.yml") ?
      { workflow_runs: result } : identity().api("") }))).rejects.toThrow("code-journey.yml");
  }
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
  const pty = validate.find((s: any) => s.run === "node packages/code/scripts/installed-journey.mjs release-code-artifacts/code.tgz");
  expect(pty.env.CODE_JOURNEY_OUTPUT).toBe("${{ github.workspace }}/release-code-artifacts");
  const retained = validate.find((s: any) => s.uses?.startsWith("actions/upload-artifact@"));
  expect(retained.with.path).toContain("release-code-artifacts/installed-journey-report.json");
  expect(retained.with.path).toContain("release-code-artifacts/installed-journey-transcript.txt");
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
test("Installed journey evidence is available for every main SHA across supported platforms", async () => {
  const workflow = Bun.YAML.parse(await readFile(new URL("../.github/workflows/code-journey.yml", import.meta.url), "utf8")) as any;
  expect(workflow.on.pull_request?.paths).toBeUndefined();
  expect(workflow.on.push.paths).toBeUndefined();
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.jobs.journey.strategy.matrix).toEqual({ os: ["ubuntu-latest", "macos-latest"], node: ["22.13.0", "24"] });
  const steps = workflow.jobs.journey.steps;
  expect(steps.some((s: any) => s.run === "bun install --cwd packages/code --frozen-lockfile --ignore-scripts")).toBe(true);
  expect(steps.some((s: any) => s.run?.includes('code-release.ts inspect "$RUNNER_TEMP/code-journey/code.tgz"'))).toBe(true);
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
