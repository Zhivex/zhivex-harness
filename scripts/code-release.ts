import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProvenanceStatement } from "./release-provenance.js";

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
export function assertCodeManifest(manifest: Manifest): void {
  assert.equal(manifest.name, packageName);
  assert.match(manifest.version, /^0\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*$/, "Code release must be an explicit 0.x RC");
  assert.notEqual(manifest.private, true);
  assert.match(manifest.dependencies["@zhivex-ai/harness"] ?? "", /^1\.[0-9]+\.[0-9]+(?:-rc\.[1-9][0-9]*)?$/, "Code pins one exact published engine");
  assert.deepEqual(manifest.bin, { "zhivex-code": "./dist/cli.js" });
  assert.deepEqual(manifest.publishConfig, { access: "public", registry, tag: "next" });
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert(!manifest.scripts?.[hook], `Forbidden lifecycle: ${hook}`);
}
export async function assertCodeReleaseIdentity(options: {
  version: string; tag: string; sha: string; ref: string; repository: string;
  run: (command: string[]) => string;
  api: (endpoint: string) => Promise<{ workflow_runs?: Array<{ head_sha: string; status: string; conclusion: string }> }>;
}): Promise<void> {
  const { run, api, sha, tag } = options;
  assert.equal(options.repository, repository);
  assert.equal(tag, `code-v${options.version}`);
  assert.equal(options.ref, `refs/tags/${tag}`, "Dispatch the exact annotated Code tag");
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(run(["git", "cat-file", "-t", tag]), "tag", "Code tag must be annotated");
  assert.equal(run(["git", "rev-parse", "HEAD"]), sha);
  assert.equal(run(["git", "rev-list", "-n", "1", tag]), sha);
  run(["git", "merge-base", "--is-ancestor", sha, "origin/main"]);
  assert.equal(run(["git", "status", "--porcelain=v1", "--untracked-files=all"]), "", "Release source must be clean");
  for (const workflow of ["ci.yml", "codeql.yml"]) {
    const response = await api(`actions/workflows/${workflow}/runs?head_sha=${sha}&branch=main&event=push&per_page=100`);
    const latest = response.workflow_runs?.[0];
    assert(latest?.head_sha === sha && latest.status === "completed" && latest.conclusion === "success", `${workflow} latest main push must pass for the exact release SHA`);
  }
}
export function assertCodeRegistryState(document: RegistryDocument, version: string, integrity: string): "absent" | "identical" {
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
async function inspect(artifact: string, manifest: Manifest) {
  const bytes = await readFile(artifact);
  const names = run(["tar", "-tzf", artifact]).split("\n");
  for (const name of names) {
    assert(!name.includes("..") && /^(package\/|package\/(package.json|README.md|LICENSE)|package\/dist\/[\w.-]+\.js)$/.test(name), `Unexpected Code payload: ${name}`);
  }
  for (const name of ["package/package.json", "package/README.md", "package/LICENSE", "package/dist/cli.js"]) assert(names.includes(name), `Missing ${name}`);
  const packed = JSON.parse(run(["tar", "-xOf", artifact, "package/package.json"])) as Manifest;
  assertCodeManifest(packed);
  assert.deepEqual(packed, manifest, "Packed manifest differs from checked-out release");
  assert(run(["tar", "-xOf", artifact, "package/dist/cli.js"]).startsWith("#!/usr/bin/env node"));
  const sha512Hex = createHash("sha512").update(bytes).digest("hex");
  return { sha512Hex, integrity: `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}` };
}
async function main() {
  const [mode, input] = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(path.join(root, "packages/code/package.json"), "utf8")) as Manifest;
  assertCodeManifest(manifest);
  const engineVersion = manifest.dependencies["@zhivex-ai/harness"]!;
  if (mode === "identity") {
    await assertCodeReleaseIdentity({ version: manifest.version, tag: process.env.RELEASE_TAG ?? "", sha: process.env.GITHUB_SHA ?? "", ref: process.env.GITHUB_REF ?? "", repository: process.env.GITHUB_REPOSITORY ?? "", run,
      api: endpoint => json(`https://api.github.com/repos/${repository}/${endpoint}`, false, true) });
    console.log("Code release identity and main CI/CodeQL verified."); return;
  }
  if (mode === "engine") {
    assert(input, "Provide destination for exact registry engine tarball");
    const engine = await json<RegistryVersion>(`${registry}%40zhivex-ai%2Fharness/${engineVersion}`);
    assert.equal(engine.name, "@zhivex-ai/harness"); assert.equal(engine.version, engineVersion);
    assert(engine.dist?.tarball && engine.dist.integrity && engine.dist.attestations?.url, "Engine release must exist with integrity and provenance");
    const response = await fetch(npmUrl(engine.dist.tarball), { signal: AbortSignal.timeout(60_000) }); assert(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, engine.dist.integrity);
    await writeFile(input, bytes); console.log(`Downloaded published Harness ${engineVersion} with verified integrity.`); return;
  }
  assert(input, "Provide exact Code artifact path");
  const artifact = path.resolve(input);
  const { sha512Hex, integrity } = await inspect(artifact, manifest);
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
  assert.equal(status, "identical"); assert.equal(document["dist-tags"]?.next, manifest.version);
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
  console.log(`Verified Code ${manifest.version}: exact registry bytes and next, GitHub provenance.`);
}
if (import.meta.main) await main();
