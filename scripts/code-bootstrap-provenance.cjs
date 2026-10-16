// npm's own provenance generator, pinned to the reviewed npm implementation.
// Used in the GitHub build job so the first authenticated publish can retain
// genuine build provenance before npm Trusted Publishing can be configured.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function inspectArtifact(artifact) {
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, '@zhivex-ai/code', 'Only Code artifacts are accepted');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/, 'A release version is required');
  assert.notEqual(manifest.private, true, 'Private development artifacts cannot be signed');
  assert.equal(manifest.repository?.url, 'git+https://github.com/Zhivex/zhivex-harness.git');
  return manifest;
}

const EQUIVALENT_ENTRY_ID = /equivalent entry already exists in the transparency log with UUID ([0-9a-f]{64,})/i;
const ENTRY_ID = /^[0-9a-f]{64,}$/i;

function entryIdFromLocation(location) {
  if (typeof location !== 'string' || location.length === 0) return undefined;
  let pathname = location.split('?')[0];
  try { pathname = new URL(location).pathname; } catch { /* relative Location values are still paths */ }
  const id = pathname.split('/').filter(Boolean).pop();
  return id && ENTRY_ID.test(id) ? id.toLowerCase() : undefined;
}

function equivalentEntryId(error) {
  const cause = error?.cause;
  const status = cause?.statusCode ?? error?.statusCode;
  if (status !== undefined && status !== 409) return undefined;
  const fromMessage = [error?.message, cause?.message]
    .map(message => typeof message === 'string' ? EQUIVALENT_ENTRY_ID.exec(message)?.[1]?.toLowerCase() : undefined)
    .find(Boolean);
  if (!fromMessage) return undefined;
  const fromLocation = entryIdFromLocation(cause?.location ?? error?.location);
  if (fromLocation && fromLocation !== fromMessage) {
    throw new Error('Transparency log conflict identified two different entries');
  }
  return fromLocation || fromMessage;
}

function certificateDer(bytes) {
  const text = bytes.toString('utf8');
  if (!text.includes('BEGIN CERTIFICATE')) return bytes;
  const der = Buffer.from(text.replace(/-----[A-Z0-9 ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  if (der.length === 0) throw new Error('Existing transparency log entry certificate is empty');
  return der;
}

function assertDsseEntryMatchesProposed(existing, proposed) {
  if (proposed?.kind !== 'dsse' || proposed.apiVersion !== '0.0.1') {
    throw new Error('Refusing to reuse a transparency log entry for a non-dsse proposal');
  }
  const envelopeJSON = proposed.spec?.proposedContent?.envelope;
  const verifiers = proposed.spec?.proposedContent?.verifiers;
  if (typeof envelopeJSON !== 'string' || !Array.isArray(verifiers) || verifiers.length !== 1) {
    throw new Error('Refusing to reuse a transparency log entry for a malformed proposal');
  }
  const envelope = JSON.parse(envelopeJSON);
  const signature = envelope?.signatures?.length === 1 ? envelope.signatures[0].sig : undefined;
  if (envelope?.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string' || typeof signature !== 'string') {
    throw new Error('Refusing to reuse a transparency log entry for an unexpected DSSE envelope');
  }
  const payloadHash = createHash('sha256').update(Buffer.from(envelope.payload, 'base64')).digest('hex');
  const envelopeHash = createHash('sha256').update(Buffer.from(envelopeJSON)).digest('hex');
  const body = JSON.parse(Buffer.from(existing?.body ?? '', 'base64').toString('utf8'));
  if (body?.kind !== 'dsse' || body.apiVersion !== '0.0.1') throw new Error('Existing transparency log entry is not a dsse v0.0.1 record');
  const logged = body.spec?.signatures?.length === 1 ? body.spec.signatures[0] : undefined;
  if (body.spec?.payloadHash?.algorithm !== 'sha256' || body.spec.payloadHash.value !== payloadHash) {
    throw new Error('Existing transparency log entry payload hash does not match this signature');
  }
  if (body.spec?.envelopeHash?.algorithm !== 'sha256' || body.spec.envelopeHash.value !== envelopeHash) {
    throw new Error('Existing transparency log entry envelope hash does not match this signature');
  }
  if (!logged || typeof logged.verifier !== 'string' || logged.signature !== signature) {
    throw new Error('Existing transparency log entry signature does not match this signature');
  }
  const loggedCertificate = certificateDer(Buffer.from(logged.verifier, 'base64'));
  const proposedCertificate = certificateDer(Buffer.from(verifiers[0], 'base64'));
  if (loggedCertificate.length === 0 || !loggedCertificate.equals(proposedCertificate)) {
    throw new Error('Existing transparency log entry certificate does not match this signature');
  }
}

// npm 11.6.1 hardcodes Sigstore fetchOnConflict to false. Rekor returns 409 when the
// same proposed entry was already integrated, which is what a timed-out create retry
// observes. Reuse that entry only when its canonical body is the entry we just signed.
function bindEquivalentTLogReuse(TLogClient) {
  const proto = TLogClient?.prototype;
  if (typeof proto?.createEntry !== 'function' || proto.createEntry.reuseEquivalentEntry) return;
  const original = proto.createEntry;
  async function createEntry(proposedEntry) {
    try {
      return await original.call(this, proposedEntry);
    } catch (error) {
      const entryId = equivalentEntryId(error);
      if (!entryId) throw error;
      if (typeof this.rekor?.getEntry !== 'function') throw new Error(`Failed to fetch existing transparency log entry ${entryId}`, { cause: error });
      const existing = await this.rekor.getEntry(entryId);
      assertDsseEntryMatchesProposed(existing, proposedEntry);
      console.log(`Reusing equivalent Rekor entry ${entryId}.`);
      return existing;
    }
  }
  createEntry.reuseEquivalentEntry = true;
  proto.createEntry = createEntry;
}

function installEquivalentTLogReuse(npmRoot) {
  const { TLogClient } = require(path.join(npmRoot, 'node_modules/@sigstore/sign/dist/witness/tlog/client.js'));
  if (typeof TLogClient?.prototype?.createEntry !== 'function') throw new Error('Pinned npm is missing the Sigstore transparency log client');
  bindEquivalentTLogReuse(TLogClient);
}

function validateBuildIdentity(manifest, env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Generate only inside GitHub Actions');
  assert.equal(env.GITHUB_REPOSITORY, 'Zhivex/zhivex-harness');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  const tag = `code-v${manifest.version}`;
  assert.equal(env.GITHUB_REF, `refs/tags/${tag}`);
  assert.equal(env.GITHUB_WORKFLOW_REF, `Zhivex/zhivex-harness/.github/workflows/release-code.yml@refs/tags/${tag}`);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), env.GITHUB_SHA);
  const checkout = JSON.parse(readFileSync('packages/code/package.json', 'utf8'));
  assert.equal(checkout.name, manifest.name);
  assert.equal(checkout.version, manifest.version);
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'GitHub OIDC permission is required');
}

async function main(args) {
  const [mode, artifactArg, bundleArg] = args;
  assert.ok(args.length === 3 && ['generate', 'verify'].includes(mode), 'Usage: node scripts/code-bootstrap-provenance.cjs generate|verify <tarball> <bundle>');
  const artifact = path.resolve(artifactArg);
  const bundlePath = path.resolve(bundleArg);
  const manifest = inspectArtifact(artifact);
  if (mode === 'generate') validateBuildIdentity(manifest);
  const npmRoot = process.env.CODE_PROVENANCE_NPM_ROOT;
  assert.ok(npmRoot && path.isAbsolute(npmRoot), 'CODE_PROVENANCE_NPM_ROOT must point to isolated npm@11.6.1');
  assert.equal(JSON.parse(readFileSync(path.join(npmRoot, 'package.json'), 'utf8')).version, '11.6.1', 'Pin npm before using its internal provenance API');
  const npa = require(path.join(npmRoot, 'node_modules/npm-package-arg'));
  const { generateProvenance, verifyProvenance } = require(path.join(npmRoot, 'node_modules/libnpmpublish/lib/provenance.js'));
  const subject = {
    name: npa.toPurl(npa.resolve(manifest.name, manifest.version)),
    digest: { sha512: createHash('sha512').update(readFileSync(artifact)).digest('hex') },
  };
  if (mode === 'generate') {
    installEquivalentTLogReuse(npmRoot);
    const bundle = await generateProvenance([subject], {});
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  }
  const verified = await verifyProvenance(subject, bundlePath);
  const sigstore = require(path.join(npmRoot, 'node_modules/sigstore'));
  await sigstore.verify(verified, {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    certificateIdentityURI: `https://github.com/Zhivex/zhivex-harness/.github/workflows/release-code.yml@refs/tags/code-v${manifest.version}`,
  });
  const statement = JSON.parse(Buffer.from(verified.dsseEnvelope.payload, 'base64').toString('utf8'));
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  assert.equal(workflow?.repository, 'https://github.com/Zhivex/zhivex-harness');
  assert.equal(workflow?.path, '.github/workflows/release-code.yml');
  assert.equal(workflow?.ref, `refs/tags/code-v${manifest.version}`);
  const expectedSha = process.env.CODE_EXPECTED_SHA || (mode === 'generate' ? process.env.GITHUB_SHA : undefined);
  assert.ok(expectedSha && /^[a-f0-9]{40}$/.test(expectedSha), 'CODE_EXPECTED_SHA required for offline verification');
  assert.ok(statement.predicate?.buildDefinition?.resolvedDependencies?.some(d => d.digest?.gitCommit === expectedSha), 'Provenance must bind the reviewed source SHA');
  console.log(`Verified Code ${manifest.version} provenance for ${expectedSha} and exact tarball SHA-512.`);
}

module.exports = { inspectArtifact, validateBuildIdentity, equivalentEntryId, assertDsseEntryMatchesProposed, bindEquivalentTLogReuse };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
