# Code release procedure

Code is released independently of Harness. The verified stable release is
`@zhivex-ai/code@0.1.0`, with the sole binary `zhivex-code`, npm tag `latest`,
and the exact dependency `@zhivex-ai/harness@1.3.0`. Harness was published and
verified first in [run 37031040747](https://github.com/Zhivex/zhivex-harness/actions/runs/37031040747). Code passed real registry
resolution, four-manager installed acceptance and source-bound provenance in
[run 37036369187](https://github.com/Zhivex/zhivex-harness/actions/runs/37036369187) at `aa86de8d700f893253559b00c1f7191e7dab48b9`.
Attempt 1 accepted publication but failed while registry metadata still reported
the version absent. Attempt 2 recovered only the failed publish job using the
retained artifact; identical bytes skipped npm publication and verification passed.
Code RC2 remains on `next`; RC1 is historical. The existing OIDC publisher and
protected environment were preserved. See [publication evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/evidence/stable-publication-2026-10-02.json).

## Release preparation

1. Merge the Code release PR after required review and successful checks.
2. Wait for the latest `ci.yml` and `codeql.yml` **push runs on main** to succeed
   for the exact commit. Keep the Code manifest, version and engine pin unchanged
   after selecting that commit.
3. Wait for Harness `1.3.0` publication and successful registry/provenance
   verification as ordered in [the Harness release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md).
   From a clean checkout of that main commit, create an annotated
   `code-v0.1.0` tag and push it. Never move or overwrite release tags.
4. Dispatch `release-code.yml` **at that tag**, with input `tag` matching it and
   `channel=latest`, `mode=oidc`, and `confirm_publication=true`. Dispatching
   main while supplying a different tag is rejected.

```sh
gh workflow run release-code.yml --ref code-v0.1.0 \
  -f tag=code-v0.1.0 -f channel=latest -f mode=oidc -f confirm_publication=true
```

The workflow validates tag identity, main ancestry, exact CI/CodeQL, Code source
and package boundaries. It downloads the pinned Harness version from npm and
verifies its integrity and SLSA artifact/workflow/tag/source binding; missing
publication or provenance stops the release.
It builds Code once, inspects package contents, installs it against the actual
registry dependency without overrides, and tests the retained Code and Harness
artifacts with npm, pnpm, Yarn and Bun. The paired matrix uses explicit engine
artifact overrides; the separate standalone installation proves npm resolution.
This does not claim every future engine version or installation order is certified.

The workflow generates genuine npm/Sigstore provenance using pinned npm 11.6.1
inside the GitHub-hosted build job. It retains `code.tgz`, `code.sigstore.json`,
`SHA512SUMS`, and installed acceptance in `code-release-<full-source-sha>`.
Bootstrap mode **does not publish**. No npm token is copied into GitHub.

## Historical first publication / future package bootstrap

npm requires the package to exist before configuring its trusted publisher;
staged publishing also requires an existing package. An authenticated scope
owner performs the first publication using the successful workflow's retained
artifact and provenance bundle. Do not rebuild the tarball locally.

These bootstrap commands apply only if authenticated first publication is
explicitly authorized for a new package. They are unnecessary for the existing
Code package. Set `RELEASE_CHANNEL` from `bun run scripts/code-release.ts channel`
and keep it consistent with the artifact.

Download the artifact from the exact successful run, then verify it in a clean
checkout of its annotated Code tag. `CODE_EXPECTED_SHA` must be that tag's full
commit SHA. Install npm 11.6.1 into an isolated tools directory and set
`CODE_PROVENANCE_NPM_ROOT` to its `node_modules/npm` directory.

```sh
(cd release-code-artifacts && shasum -a 512 -c SHA512SUMS)
bun run scripts/code-release.ts inspect release-code-artifacts/code.tgz
CODE_EXPECTED_SHA="$(git rev-list -n 1 code-v0.1.0)" \
  node scripts/code-bootstrap-provenance.cjs verify \
  release-code-artifacts/code.tgz release-code-artifacts/code.sigstore.json
node "$CODE_PROVENANCE_NPM_ROOT/bin/npm-cli.js" publish \
  ./release-code-artifacts/code.tgz --ignore-scripts --access public \
  --tag "$RELEASE_CHANNEL" --provenance-file ./release-code-artifacts/code.sigstore.json
bun run scripts/code-release.ts verify release-code-artifacts/code.tgz
```

The provenance verifier checks the Sigstore signature, GitHub issuer, exact
workflow/tag identity, source commit and tarball digest. Complete any npm 2FA
challenge directly; do not put a one-time code into documentation or logs. If npm
accepts publication but verification fails, inspect registry state and retry
verification with the same retained bytes. An existing different digest is a
hard failure; never attempt to replace that version.

## Subsequent releases with Trusted Publishing

In npm package settings, configure GitHub Actions with organization `Zhivex`,
repository `zhivex-harness`, workflow filename `release-code.yml`, and environment
`npm`. Enable the allowed action `npm publish`; the OIDC job uses direct
publishing after GitHub approval, not `npm stage publish`. Preserve the GitHub
environment's required human approval. Then prepare a
new Code stable or RC version and annotated tag through the same PR and main CI process.
Dispatch its tag with the matching channel, `mode=oidc` and
`confirm_publication=true`. Stable versions require `latest` and a stable exact
Harness dependency; canonical RC versions require `next`. Version/channel drift
fails before engine downloads. An RC may pin a stable engine. Stable publication
does not upgrade beta/experimental APIs, provisional providers or Desktop alpha.

All Code tags share one workflow concurrency group. Before publishing, the
registry gate rejects moving the selected channel back to an older release, including when
GitHub schedules queued workflows out of order.

The publish job downloads the validated artifact without rebuilding it,
rechecks identity and digest after protected approval, and uses npm OIDC plus
provenance. It verifies registry tarball bytes, the selected `latest`/`next` distribution tag and
SLSA source/workflow identity. A successful dispatch or tag is not publication;
only successful registry verification confirms the release. When a run has
already published, rerun only the failed publish job to retain original bytes.

Official references: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and
[npm staged publishing](https://docs.npmjs.com/staged-publishing/).
