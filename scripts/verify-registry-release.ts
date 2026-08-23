import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

import { readRegularFileNoFollow } from "../src/file-security.js";
import { assertHarnessReleaseChannel } from "./release-policy.js";
import {
  assertReleaseProvenance,
  type ProvenanceStatement
} from "./release-provenance.js";
import {
  RegistryPropagationDeadlineError,
  RegistryPropagationError,
  runWithPropagationDeadline,
  timeoutWithinDeadline
} from "./release-verification-deadline.js";

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

const workspace = path.resolve(import.meta.dir, "..");
const PACKAGE_NAME = "@zhivex-ai/harness";
const PACKAGE_REGISTRY_URL = "https://registry.npmjs.org/%40zhivex-ai%2Fharness";
const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const artifactArgument = process.argv[2];
const channel = process.argv[3] ?? "latest";
if (!artifactArgument) {
  throw new Error("Usage: bun run release:verify -- <package.tgz> [channel]");
}

const artifact = path.resolve(process.cwd(), artifactArgument);
const manifest = JSON.parse(
  (await readRegularFileNoFollow(path.join(workspace, "package.json"), {
    label: "Release package.json",
    maxBytes: 1024 * 1024
  })).contents.toString("utf8")
) as PackageManifest;
assert.equal(manifest.name, PACKAGE_NAME, "release package name is unexpected");
assertHarnessReleaseChannel(manifest.version, channel);
const releaseTag = `v${manifest.version}`;
const tagType = (await Bun.$`git -C ${workspace} cat-file -t ${releaseTag}`.text()).trim();
assert.equal(tagType, "tag", `${releaseTag} must exist locally as an annotated tag`);
const releaseCommit = (
  await Bun.$`git -C ${workspace} rev-list -n 1 ${releaseTag}`.text()
).trim();
const mainAncestor = Bun.spawnSync(
  ["git", "-C", workspace, "merge-base", "--is-ancestor", releaseCommit, "origin/main"],
  { stdout: "ignore", stderr: "pipe" }
);
assert.equal(
  mainAncestor.exitCode,
  0,
  `${releaseTag} commit ${releaseCommit} is not reachable from origin/main`
);
const artifactBytes = (await readRegularFileNoFollow(artifact, {
  label: "Release artifact",
  maxBytes: MAX_RELEASE_ARTIFACT_BYTES
})).contents;
const sha512Hex = createHash("sha512").update(artifactBytes).digest("hex");
const expectedIntegrity = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
const packageUrl = PACKAGE_REGISTRY_URL;
const propagationWindowMs = 5 * 60_000;
const retryDelayMs = 10_000;
const propagationDeadlineMs = performance.now() + propagationWindowMs;

const fetchJson = async <T>(url: string, deadlineMs: number): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineMs, 15_000))
    });
  } catch (error) {
    throw new RegistryPropagationError(
      `${url} request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 404 || response.status === 429 || response.status >= 500) {
    throw new RegistryPropagationError(`${url} returned HTTP ${response.status}`);
  }
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return await response.json() as T;
};

const requirePropagated = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new RegistryPropagationError(message);
};

const verify = async (deadlineMs: number): Promise<void> => {
  const registry = await fetchJson<RegistryDocument>(packageUrl, deadlineMs);
  requirePropagated(
    registry["dist-tags"]?.[channel] === manifest.version,
    `${channel} does not point to ${manifest.version}`
  );
  const published = registry.versions?.[manifest.version];
  requirePropagated(published, `${manifest.name}@${manifest.version} is absent from the registry`);
  assert.equal(published.dist?.integrity, expectedIntegrity, "registry integrity differs from the exact release artifact");
  assert(published.dist?.tarball, "registry metadata has no tarball URL");
  requirePropagated(
    published.dist.attestations?.provenance?.predicateType === "https://slsa.dev/provenance/v1",
    "registry metadata has no SLSA v1 provenance"
  );
  requirePropagated(published.dist.attestations.url, "registry metadata has no attestation URL");

  let tarballResponse: Response;
  try {
    tarballResponse = await fetch(published.dist.tarball, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineMs, 30_000))
    });
  } catch (error) {
    throw new RegistryPropagationError(
      `published tarball request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (tarballResponse.status === 404 || tarballResponse.status === 429 || tarballResponse.status >= 500) {
    throw new RegistryPropagationError(`published tarball returned HTTP ${tarballResponse.status}`);
  }
  assert(tarballResponse.ok, `published tarball returned HTTP ${tarballResponse.status}`);
  const publishedBytes = Buffer.from(await tarballResponse.arrayBuffer());
  const publishedIntegrity = `sha512-${createHash("sha512").update(publishedBytes).digest("base64")}`;
  assert.equal(publishedIntegrity, expectedIntegrity, "published tarball bytes differ from the exact release artifact");

  const attestations = await fetchJson<AttestationDocument>(
    published.dist.attestations.url,
    deadlineMs
  );
  const provenance = attestations.attestations?.find(
    (candidate) => candidate.predicateType === "https://slsa.dev/provenance/v1"
  );
  requirePropagated(provenance?.bundle?.dsseEnvelope?.payload, "SLSA provenance envelope is missing");
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8")
  ) as ProvenanceStatement;
  assertReleaseProvenance({
    statement,
    version: manifest.version,
    sha512Hex,
    releaseCommit
  });
};

try {
  await runWithPropagationDeadline(verify, {
    deadlineMs: propagationDeadlineMs,
    retryDelayMs
  });
  process.stdout.write(
    `Published release verified for ${manifest.name}@${manifest.version}: exact integrity, ${channel} tag, and SLSA workflow provenance match ${releaseTag} at ${releaseCommit.slice(0, 12)}.\n`
  );
} catch (error) {
  const lastError = error instanceof RegistryPropagationDeadlineError
    ? error.lastError
    : error;
  throw new Error(
    `Published release verification failed${error instanceof RegistryPropagationDeadlineError ? " after five minutes of registry propagation retries" : ""}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
