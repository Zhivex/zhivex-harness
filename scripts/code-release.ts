import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProvenanceStatement } from "./release-provenance.js";
import { assertReleaseProvenance } from "./release-provenance.js";

const root = path.resolve(import.meta.dir, "..");
const repository = "Zhivex/zhivex-harness";
const registry = "https://registry.npmjs.org/";
const packageName = "@zhivex-ai/code";
interface Manifest {
  name: string; version: string; private?: boolean;
  dependencies: Record<string, string>; bin: Record<string, string>;
  publishConfig?: { access?: string; registry?: string; tag?: string };
  scripts?: Record<string, string>;
}
interface RegistryVersion {
  name: string; version: string;
  dist?: { integrity?: string; tarball?: string; attestations?: { url?: string } };
}
interface RegistryDocument {
  versions?: Record<string, RegistryVersion>; "dist-tags"?: Record<string, string>;
}
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;
function releaseParts(version: string): number[] {
  const match = versionPattern.exec(version);
  assert(match, "Expected canonical stable SemVer or X.Y.Z-rc.N");
  const parts = match.slice(1, 4).map(Number);
  // A stable version sorts after every RC of the same version.
  parts.push(match[4] === undefined ? Infinity : Number(match[4]));
  assert(parts.slice(0, 3).every(Number.isSafeInteger) &&
    (match[4] === undefined || Number.isSafeInteger(parts[3])), "Release numbers must be safe integers");
  return parts;
}
export function codeReleaseChannel(version: string): "latest" | "next" {
  const parts = releaseParts(version);
  assert.equal(parts[0], 0, "Code release must be on the explicit 0.x line");
  return parts[3] === Infinity ? "latest" : "next";
}
export function assertCodeReleaseChannel(version: string, channel: string): void {
  assert.equal(channel, codeReleaseChannel(version), "Stable Code must use latest; RC Code must use next");
}
export function assertCodeManifest(manifest: Manifest): void {
  assert.equal(manifest.name, packageName);
  const channel = codeReleaseChannel(manifest.version);
  assert.notEqual(manifest.private, true);
  const engine = releaseParts(manifest.dependencies["@zhivex-ai/harness"] ?? "");
  assert.equal(engine[0], 1, "Code pins one exact Harness 1.x engine");
  if (channel === "latest") assert.equal(engine[3], Infinity, "Stable Code requires a stable Harness dependency");
  assert.deepEqual(manifest.bin, { "zhivex-code": "./dist/cli.js" });
  assert.deepEqual(manifest.publishConfig, { access: "public", registry, tag: channel });
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert(!manifest.scripts?.[hook], `Forbidden lifecycle: ${hook}`);
}
export async function assertCodeReleaseIdentity(options: {
  version: string; channel: string; tag: string; sha: string; ref: string; repository: string;
  run: (command: string[]) => string;
  api: (endpoint: string) => Promise<{ workflow_runs?: Array<{ head_sha: string; status: string; conclusion: string }> }>;
}): Promise<void> {
  const { run, api, sha, tag } = options;
  assertCodeReleaseChannel(options.version, options.channel);
  assert.equal(options.repository, repository);
  assert.equal(tag, `code-v${options.version}`);
  assert.equal(options.ref, `refs/tags/${tag}`, "Dispatch the exact annotated Code tag");
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(run(["git", "cat-file", "-t", tag]), "tag", "Code tag must be annotated");
  assert.equal(run(["git", "rev-parse", "HEAD"]), sha);
  assert.equal(run(["git", "rev-list", "-n", "1", tag]), sha);
  run(["git", "merge-base", "--is-ancestor", sha, "origin/main"]);
  assert.equal(run(["git", "status", "--porcelain=v1", "--untracked-files=all"]), "", "Release source must be clean");
  for (const workflow of ["ci.yml", "codeql.yml", "code-journey.yml", "web.yml"]) {
    const response = await api(`actions/workflows/${workflow}/runs?head_sha=${sha}&branch=main&event=push&per_page=100`);
    const latest = response.workflow_runs?.[0];
    assert(latest?.head_sha === sha && latest.status === "completed" && latest.conclusion === "success", `${workflow} latest main push must pass for the exact release SHA`);
  }
}
export function assertCodeRegistryState(document: RegistryDocument, version: string, integrity: string): "absent" | "identical" {
  const channel = codeReleaseChannel(version);
  const current = document["dist-tags"]?.[channel];
  if (current && current !== version) {
    const wanted = releaseParts(version), existing = releaseParts(current);
    assert.equal(existing[0], 0, "Cannot order Code channel safely; investigate registry state");
    if (channel === "next") assert.notEqual(existing[3], Infinity, "Cannot order next safely; investigate registry state");
    const firstDifference = wanted.findIndex((value, index) => value !== existing[index]);
    assert(firstDifference >= 0 && wanted[firstDifference]! > existing[firstDifference]!, `Refusing to move ${channel} back to an older Code release`);
  }
  const found = document.versions?.[version];
  if (!found) return "absent";
  assert.equal(found.dist?.integrity, integrity, "Published version has different immutable bytes; never rebuild or overwrite it");
  return "identical";
}
export function assertCodeProvenance(statement: ProvenanceStatement, sha512Hex: string, version: string, sha: string): void {
  assert(statement.subject?.some(subject => subject.digest?.sha512 === sha512Hex), "Provenance must bind exact artifact");
  const definition = statement.predicate?.buildDefinition;
  assert.deepEqual(definition?.externalParameters?.workflow, {
    repository: `https://github.com/${repository}`, path: ".github/workflows/release-code.yml", ref: `refs/tags/code-v${version}`
  });
  assert(definition?.resolvedDependencies?.some(dependency => dependency.digest?.gitCommit === sha), "Provenance must bind release commit");
  assert.equal(statement.predicate?.runDetails?.builder?.id, "https://github.com/actions/runner/github-hosted");
  assert(statement.predicate?.runDetails?.metadata?.invocationId?.startsWith(`https://github.com/${repository}/actions/runs/`));
}
function run(command: string[], cwd = root): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", timeout: 600_000, env: process.env });
  assert.equal(result.status, 0, `${command[0]} ${command[1]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function json<T>(url: string, allow404 = false, github = false): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json", "cache-control": "no-cache", ...(github ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(30_000) });
  if (allow404 && response.status === 404) return {} as T;
  assert(response.ok, `Read ${url} failed: HTTP ${response.status}`);
  return await response.json() as T;
}
function npmUrl(url: string): string {
  assert.equal(new URL(url).origin, new URL(registry).origin, "Registry artifacts must use npmjs.org HTTPS");
  return url;
}
const codePayloadFiles = [
  "package/package.json", "package/README.md", "package/CHANGELOG.md", "package/LICENSE", "package/dist/cli.js",
  "package/examples/first-use.mjs", "package/examples/offline-provider.mjs", "package/docs/TASK_DELIVERY.md",
  "package/dist/web-assets/index.html",
  "package/dist/web-assets/zhivex-icon.png",
];
export function assertCodePayload(names: string[]): void {
  assert.equal(new Set(names).size, names.length, "Duplicate Code payload entries");
  for (const name of names) {
    assert(codePayloadFiles.includes(name) || ["package/", "package/dist/", "package/examples/", "package/docs/"].includes(name) ||
      /^package\/dist\/[A-Za-z0-9_-]+\.js$/.test(name) ||
      ["package/dist/web-assets/", "package/dist/web-assets/assets/", "package/dist/web-assets/index.html"].includes(name) ||
      /^package\/dist\/web-assets\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(name), `Unexpected Code payload: ${name}`);
  }
  for (const name of codePayloadFiles) assert(names.includes(name), `Missing ${name}`);
  for (const extension of ["js", "css"]) {
    assert(names.some(name => /^package\/dist\/web-assets\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(name) &&
      name.endsWith(`.${extension}`)), `Missing compiled web ${extension} asset`);
  }
}
export async function inspectCodeArtifact(artifact: string, manifest: Manifest) {
  const bytes = await readFile(artifact);
  const names = run(["tar", "-tzf", artifact]).split("\n");
  assertCodePayload(names);
  const entries = run(["tar", "-tvzf", artifact]).split("\n");
  assert.equal(entries.length, names.length);
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry[0], names[index]!.endsWith("/") ? "d" : "-", "Code payload must contain only regular files and named directories");
  }
  const packed = JSON.parse(run(["tar", "-xOf", artifact, "package/package.json"])) as Manifest;
  assertCodeManifest(packed);
  assert.deepEqual(packed, manifest, "Packed manifest differs from checked-out release");
  assert(run(["tar", "-xOf", artifact, "package/dist/cli.js"]).startsWith("#!/usr/bin/env node"));
  const html = run(["tar", "-xOf", artifact, "package/dist/web-assets/index.html"]);
  const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]!);
  for (const extension of ["js", "css"]) {
    assert(references.some(name => name.endsWith(`.${extension}`)), `Missing web index ${extension} reference`);
  }
  for (const reference of references) {
    assert(/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(reference), `Invalid web asset reference: ${reference}`);
    const entry = `package/dist/web-assets${reference}`;
    assert(names.includes(entry), `Missing referenced web asset: ${entry}`);
    assert(run(["tar", "-xOf", artifact, entry]).length, `Empty web asset: ${entry}`);
  }
  const logo = spawnSync("tar", ["-xOf", artifact, "package/dist/web-assets/zhivex-icon.png"], { timeout: 10_000 });
  assert.equal(logo.status, 0, "Missing bundled Zhivex icon");
  assert.equal(createHash("sha256").update(logo.stdout).digest("hex"),
    "b4e2b4da0a8a2866e2c27bac3165e4e86510fd8dc0d50b02c0a9c8374150a96f", "Invalid bundled Zhivex icon");
  const sha512Hex = createHash("sha512").update(bytes).digest("hex");
  return { sha512Hex, integrity: `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}` };
}
async function main() {
  const [mode, input] = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(path.join(root, "packages/code/package.json"), "utf8")) as Manifest;
  assertCodeManifest(manifest);
  const channel = codeReleaseChannel(manifest.version);
  if (process.env.RELEASE_CHANNEL !== undefined) assertCodeReleaseChannel(manifest.version, process.env.RELEASE_CHANNEL);
  const engineVersion = manifest.dependencies["@zhivex-ai/harness"]!;
  if (mode === "channel") { console.log(channel); return; }
  if (mode === "identity") {
    await assertCodeReleaseIdentity({ version: manifest.version, channel: process.env.RELEASE_CHANNEL ?? "", tag: process.env.RELEASE_TAG ?? "", sha: process.env.GITHUB_SHA ?? "", ref: process.env.GITHUB_REF ?? "", repository: process.env.GITHUB_REPOSITORY ?? "", run,
      api: endpoint => json(`https://api.github.com/repos/${repository}/${endpoint}`, false, true) });
    console.log("Code release identity and exact main CI/CodeQL/installed/web workflows verified."); return;
  }
  if (mode === "engine") {
    assert(input, "Provide destination for exact registry engine tarball");
    // npm owns registry transport; only the validated public package/version is queried.
    const engine = JSON.parse(run(["npm", "view", `@zhivex-ai/harness@${engineVersion}`, "--json", "--registry", registry])) as RegistryVersion;
    assert.equal(engine.name, "@zhivex-ai/harness"); assert.equal(engine.version, engineVersion);
    assert(engine.dist?.tarball && engine.dist.integrity && engine.dist.attestations?.url, "Engine release must exist with integrity and provenance");
    npmUrl(engine.dist.tarball);
    const download = await mkdtemp(path.join(os.tmpdir(), "code-release-engine-"));
    try {
      // Fetch the exact registry tarball through npm without lifecycle scripts.
      const packed = JSON.parse(run(["npm", "pack", engine.dist.tarball, "--json", "--ignore-scripts", "--pack-destination", download, "--registry", registry])) as Array<{ filename: string }>;
      assert.equal(packed.length, 1);
      const filename = packed[0]!.filename;
      assert.equal(path.basename(filename), filename, "npm must return a local tarball basename");
      const downloaded = path.join(download, filename);
      const bytes = await readFile(downloaded);
      assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, engine.dist.integrity);
      const installed = JSON.parse(run(["tar", "-xOf", downloaded, "package/package.json"])) as Manifest;
      assert.equal(installed.name, "@zhivex-ai/harness"); assert.equal(installed.version, engineVersion);
      const attestation = await json<{ attestations?: Array<{ predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }> }>(npmUrl(engine.dist.attestations.url));
      const payload = attestation.attestations?.find(item => item.predicateType === "https://slsa.dev/provenance/v1")?.bundle?.dsseEnvelope?.payload;
      assert(payload, "Engine requires SLSA provenance bound to its artifact and release tag");
      const engineTag = `v${engineVersion}`;
      assert.equal(run(["git", "cat-file", "-t", engineTag]), "tag", "Engine tag must be annotated");
      assertReleaseProvenance({ statement: JSON.parse(Buffer.from(payload, "base64").toString("utf8")), version: engineVersion,
        sha512Hex: createHash("sha512").update(bytes).digest("hex"), releaseCommit: run(["git", "rev-list", "-n", "1", engineTag]) });
      await copyFile(downloaded, input);
    } finally { await rm(download, { recursive: true, force: true }); }
    console.log(`Downloaded published Harness ${engineVersion} with verified integrity and source-bound provenance.`); return;
  }
  assert(input, "Provide exact Code artifact path");
  const artifact = path.resolve(input);
  const { sha512Hex, integrity } = await inspectCodeArtifact(artifact, manifest);
  if (mode === "inspect") {
    await writeFile(path.join(path.dirname(artifact), "SHA512SUMS"), `${sha512Hex}  ${path.basename(artifact)}\n`);
    console.log(`${manifest.name}@${manifest.version}: ${integrity}`); return;
  }
  if (mode === "smoke-registry") {
    // No overrides, links or local engine: this is the user's actual dependency resolution.
    const consumer = await mkdtemp(path.join(os.tmpdir(), "code-registry-consumer-"));
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "code-release-consumer", private: true }));
    run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry, artifact], consumer);
    const engine = JSON.parse(await readFile(path.join(consumer, "node_modules/@zhivex-ai/harness/package.json"), "utf8")) as Manifest;
    assert.equal(engine.version, engineVersion);
    const binary = path.join(consumer, "node_modules/@zhivex-ai/code/dist/cli.js");
    assert.equal(run(["node", binary, "--version"], consumer), manifest.version);
    assert(run(["node", binary, "--help"], consumer).includes("Zhivex Code"));
    const providers = JSON.parse(run(["node", binary, "providers", "--json"], consumer));
    assert.equal(providers.kind, "providers"); console.log(`Standalone registry dependency acceptance passed: Code ${manifest.version}, Harness ${engineVersion}.`); return;
  }
  assert(["status", "verify"].includes(mode ?? ""), "Unknown release command");
  const document = await json<RegistryDocument>(`${registry}%40zhivex-ai%2Fcode`, true);
  const status = assertCodeRegistryState(document, manifest.version, integrity);
  if (mode === "status") { console.log(status); return; }
  assert.equal(status, "identical"); assert.equal(document["dist-tags"]?.[channel], manifest.version);
  const published = document.versions![manifest.version]!;
  assert(published.dist?.tarball);
  const response = await fetch(npmUrl(published.dist.tarball), { signal: AbortSignal.timeout(60_000) }); assert(response.ok);
  assert.equal(createHash("sha512").update(Buffer.from(await response.arrayBuffer())).digest("hex"), sha512Hex);
  {
    assert(published.dist.attestations?.url, "OIDC publication requires npm provenance");
    const attestation = await json<{ attestations?: Array<{ predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }> }>(npmUrl(published.dist.attestations.url));
    const payload = attestation.attestations?.find(item => item.predicateType === "https://slsa.dev/provenance/v1")?.bundle?.dsseEnvelope?.payload;
    assert(payload, "Missing SLSA provenance payload");
    const tag = `code-v${manifest.version}`;
    assert.equal(run(["git", "cat-file", "-t", tag]), "tag");
    assertCodeProvenance(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), sha512Hex, manifest.version, run(["git", "rev-list", "-n", "1", tag]));
  }
  console.log(`Verified Code ${manifest.version}: exact registry bytes and ${channel}, GitHub provenance.`);
}
if (import.meta.main) await main();
