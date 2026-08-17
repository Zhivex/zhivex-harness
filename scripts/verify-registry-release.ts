import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

interface PackageManifest {
  name: string;
  version: string;
}

interface RegistryDocument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, {
    dist?: {
      integrity?: string;
      tarball?: string;
      attestations?: {
        url?: string;
        provenance?: { predicateType?: string };
      };
    };
  }>;
}

interface AttestationDocument {
  attestations?: Array<{
    predicateType?: string;
    bundle?: {
      dsseEnvelope?: { payload?: string };
    };
  }>;
}

interface ProvenanceStatement {
  subject?: Array<{ name?: string; digest?: { sha512?: string } }>;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: { repository?: string; path?: string; ref?: string };
      };
      resolvedDependencies?: Array<{
        uri?: string;
        digest?: { gitCommit?: string };
      }>;
    };
    runDetails?: {
      builder?: { id?: string };
      metadata?: { invocationId?: string };
    };
  };
}

const workspace = path.resolve(import.meta.dir, "..");
const artifactArgument = process.argv[2];
const channel = process.argv[3] ?? "latest";
if (!artifactArgument) {
  throw new Error("Usage: bun run release:verify -- <package.tgz> [channel]");
}
if (!/^(?:latest|next)$/.test(channel)) {
  throw new Error(`Unsupported release channel ${channel}`);
}

const artifact = path.resolve(process.cwd(), artifactArgument);
assert((await stat(artifact)).isFile(), `${artifact} is not a regular file`);
const manifest = JSON.parse(
  await readFile(path.join(workspace, "package.json"), "utf8")
) as PackageManifest;
const head = (await Bun.$`git -C ${workspace} rev-parse HEAD`.text()).trim();
const artifactBytes = await readFile(artifact);
const sha512Hex = createHash("sha512").update(artifactBytes).digest("hex");
const expectedIntegrity = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`;

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return await response.json() as T;
};

const verify = async (): Promise<void> => {
  const registry = await fetchJson<RegistryDocument>(packageUrl);
  assert.equal(
    registry["dist-tags"]?.[channel],
    manifest.version,
    `${channel} does not point to ${manifest.version}`
  );
  const published = registry.versions?.[manifest.version];
  assert(published, `${manifest.name}@${manifest.version} is absent from the registry`);
  assert.equal(published.dist?.integrity, expectedIntegrity, "registry integrity differs from the exact release artifact");
  assert(published.dist?.tarball, "registry metadata has no tarball URL");
  assert.equal(
    published.dist.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
    "registry metadata has no SLSA v1 provenance"
  );
  assert(published.dist.attestations.url, "registry metadata has no attestation URL");

  const tarballResponse = await fetch(published.dist.tarball, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(30_000)
  });
  assert(tarballResponse.ok, `published tarball returned HTTP ${tarballResponse.status}`);
  const publishedBytes = Buffer.from(await tarballResponse.arrayBuffer());
  const publishedIntegrity = `sha512-${createHash("sha512").update(publishedBytes).digest("base64")}`;
  assert.equal(publishedIntegrity, expectedIntegrity, "published tarball bytes differ from the exact release artifact");

  const attestations = await fetchJson<AttestationDocument>(published.dist.attestations.url);
  const provenance = attestations.attestations?.find(
    (candidate) => candidate.predicateType === "https://slsa.dev/provenance/v1"
  );
  assert(provenance?.bundle?.dsseEnvelope?.payload, "SLSA provenance envelope is missing");
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8")
  ) as ProvenanceStatement;
  const subject = statement.subject?.find((candidate) => candidate.digest?.sha512 === sha512Hex);
  assert(subject, "provenance subject does not bind the published SHA-512 digest");

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  assert.equal(workflow?.repository, "https://github.com/Zhivex/zhivex-harness");
  assert.equal(workflow?.path, ".github/workflows/release.yml");
  assert.equal(workflow?.ref, "refs/heads/main");
  const resolvedCommit = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
    (dependency) => dependency.digest?.gitCommit
  )?.digest?.gitCommit;
  assert.equal(resolvedCommit, head, "provenance source commit differs from the release checkout");
  assert.equal(
    statement.predicate?.runDetails?.builder?.id,
    "https://github.com/actions/runner/github-hosted"
  );
  assert(
    statement.predicate?.runDetails?.metadata?.invocationId?.startsWith(
      "https://github.com/Zhivex/zhivex-harness/actions/runs/"
    ),
    "provenance invocation does not point to the Zhivex release workflow"
  );
};

let lastError: unknown;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    await verify();
    process.stdout.write(
      `Published release verified for ${manifest.name}@${manifest.version}: exact integrity, ${channel} tag, and SLSA workflow provenance match ${head.slice(0, 12)}.\n`
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 12) {
      await Bun.sleep(5_000);
    }
  }
}

throw new Error(
  `Published release verification failed after registry propagation retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
);
