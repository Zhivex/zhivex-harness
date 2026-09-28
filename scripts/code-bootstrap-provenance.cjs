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

module.exports = { inspectArtifact, validateBuildIdentity };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
