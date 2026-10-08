# Code release procedure

## Current RC preparation: 2026-10-08

This checkout prepares Code `0.3.0-rc.7`, pinned exactly to Harness
`1.4.0-rc.7`, for npm `next`. The matched engine includes the reviewed work on
main after published RC.6: optional Web task/project limits
([PR189](https://github.com/Zhivex/zhivex-harness/pull/189)), sanitized Qwen
stream diagnostics ([PR188](https://github.com/Zhivex/zhivex-harness/pull/188)),
bounded guided task authority ([PR187](https://github.com/Zhivex/zhivex-harness/pull/187)),
private Desktop Electron 44.5.1 ([PR180](https://github.com/Zhivex/zhivex-harness/pull/180)),
task cancellation persistence ([PR190](https://github.com/Zhivex/zhivex-harness/pull/190))
and task continuity from durable authority ([PR191](https://github.com/Zhivex/zhivex-harness/pull/191)).
Retain terminal/local browser contracts, the SDK pins already on main, approval
and transport protections, provider/API tiers and RC.4 migration requirements.
Desktop stays private alpha with the same engine binding. Stable Code `0.2.0`
and Harness `1.3.0` on `latest` remain unchanged. Published npm `next` is Code
`0.3.0-rc.6` and Harness `1.4.0-rc.6`.

Harness [RC.6](https://github.com/Zhivex/zhivex-harness/actions/runs/37395585612)
completed at annotated `v1.4.0-rc.6` on `0adf4e2e96380864ef4c697ea94df64ad7c18eec`.
Code [run 37399657231](https://github.com/Zhivex/zhivex-harness/actions/runs/37399657231)
accepted `code-v0.3.0-rc.6` and then failed its immediate registry identity
assertion while metadata still reported the version absent. The registry now
serves that Code version on `next`. Do not rerun, replace or retag it as part of
this preparation. See the authoritative
[Harness release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md)
for exact immutable identities and preserved RC.5/RC.4 history. The RC.6 and
older preparation snapshots below remain historical; their evidence and approvals
do not certify or authorize RC.7.

This preparation creates no tags, paid calls, campaign dispatch or publication.
After review and user integration, require all four successful exact-main workflows
(`ci.yml`, `codeql.yml`, `code-journey.yml`, `web.yml`) and direct-main CodeQL.
New explicit campaign/publication authority is required before any Harness
`v1.4.0-rc.7` or Code `code-v0.3.0-rc.7` tag/dispatch. Harness must first pass its
unchanged protected exact-artifact, OCI, live and representative gates and actual
registry integrity/provenance verification. Code's protected OIDC workflow then
uses the matching reviewed SHA with `channel=next`, `mode=oidc` and explicit
confirmation, resolving the actual published Harness dependency without overrides.
Retained-artifact terminal/web, four-manager acceptance and registry bytes with
source-bound provenance remain mandatory. Preserve stable `latest` and all history.

## Historical RC.6 preparation: 2026-10-05

This checkout prepares Code `0.3.0-rc.6`, pinned exactly to Harness
`1.4.0-rc.6`, for npm `next`. The matched engine includes the reviewed bounded
activity projection fix from [PR185](https://github.com/Zhivex/zhivex-harness/pull/185).
Retain terminal/local browser contracts, existing SDK/model pins, approval and
transport protections, provider/API tiers and RC.4 migration requirements.
Desktop stays private alpha with the same engine binding. Stable Code `0.2.0`
and Harness `1.3.0` on `latest`, and published Code `0.3.0-rc.1` and Harness
`1.4.0-rc.1` on `next`, remain unchanged.

Harness [RC.5 attempt 1](https://github.com/Zhivex/zhivex-harness/actions/runs/37384044231)
passed offline/live and 42/42 representative gates but remains held at npm review.
Its immutable tag/source does not contain PR185; neither RC.5 package was published
and no Code RC.5 tag/release was started. Do not approve, cancel, alter or relaunch
the held campaign as part of this preparation. See the authoritative
[Harness release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md)
for exact immutable identities and preserved RC.4 failure history. The RC.5 and
older preparation snapshots below remain historical; their passing evidence and
approvals do not certify or authorize RC.6.

This preparation creates no tags, paid calls, campaign dispatch or publication.
After review and user integration, require all four successful exact-main workflows
(`ci.yml`, `codeql.yml`, `code-journey.yml`, `web.yml`) and direct-main CodeQL.
New explicit campaign/publication authority is required before any Harness
`v1.4.0-rc.6` or Code `code-v0.3.0-rc.6` tag/dispatch. Harness must first pass its
unchanged protected exact-artifact, OCI, live and representative gates and actual
registry integrity/provenance verification. Code's protected OIDC workflow then
uses the matching reviewed SHA with `channel=next`, `mode=oidc` and explicit
confirmation, resolving the actual published Harness dependency without overrides.
Retained-artifact terminal/web, four-manager acceptance and registry bytes with
source-bound provenance remain mandatory. Preserve stable `latest` and all history.

## Historical RC.5 preparation: 2026-10-05

This checkout prepares Code `0.3.0-rc.5`, pinned exactly to Harness
`1.4.0-rc.5`, for npm `next`. Retain the published SDK pins, existing terminal
and local browser contracts, API/provider tiers and the RC.4 migration
requirements. Desktop remains private alpha with its matched engine binding.
Stable Code `0.2.0`/Harness `1.3.0` on `latest` and published Code
`0.3.0-rc.1`/Harness `1.4.0-rc.1` on `next` remain unchanged.

Harness RC.4 [attempt 1](https://github.com/Zhivex/zhivex-harness/actions/runs/37360365544)
failed offline before retaining a release tarball or running paid/provider gates.
Its annotated tag, original source and failed evidence are immutable; the
approved single campaign was consumed. RC.5 includes the reviewed test
correction on new source. See the authoritative [Harness release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md)
for that failure identity, exact-source gates and the new campaign approval.
The RC.4 preparation snapshot below is historical.

Preparation approval does not create tags, dispatch a campaign or publish either
package. After review and integration, require all four exact-main workflows
(`ci.yml`, `codeql.yml`, `code-journey.yml`, `web.yml`) and direct-main CodeQL.
A separately approved Harness `v1.4.0-rc.5` campaign must pass unchanged protected
gates and actual registry integrity/provenance verification first. Code then
uses a new annotated `code-v0.3.0-rc.5` tag on the same SHA, `channel=next`,
`mode=oidc` and explicit publication confirmation. Its protected workflow must
resolve the real published Harness dependency without overrides, verify the
retained artifact with terminal/web and four-manager acceptance, and confirm
registry bytes and source-bound provenance. Preserve stable `latest` and all
historical tags/artifacts; earlier approval does not authorize this publication.

## Historical RC.4 preparation: 2026-10-05

This checkout prepares Harness `1.4.0-rc.4` and Code `0.3.0-rc.4`, both on
`next`, with Code pinned exactly to the Harness candidate. npm currently reports
Harness `1.3.0` and Code `0.2.0` on `latest`; those stable tags must not move.
Harness `1.4.0-rc.1` and Code `0.3.0-rc.1` are already published on `next`
from `9a1b1d25296567262438178d25cccfc474643aeb`; preserve those immutable
versions and annotated tags. RC.2 and RC.3 remain unpublished; preserve their tags,
retained artifacts and failed attempts at their original source commits.
[RC.3 attempt 1](https://github.com/Zhivex/zhivex-harness/actions/runs/37244691105)
failed Meta multi-process continuity at phase 2; the other five providers and all
mixed routes passed. The immediate JSON evaluation failure has an unknown upstream
cause because the original stream was not retained. Meta 0.2.9 fixes reasoning
usage reporting; it does not establish or resolve that historical cause.
RC.4 integrates the published SDK batch and bounded continuity evidence, retaining
the same model pins, ceilings, acceptance checks and certification gates. RC.4
requires its own exact artifact and source-bound certification. Both matched RC.4
candidates remain unpublished; no live calls were made during preparation.
Review and integrate the preparation PR, then
require the latest successful `ci.yml`, `codeql.yml`, `code-journey.yml` and
`web.yml` main-push runs for the exact release SHA, including the separate CodeQL
security result. Run Harness's existing preparation and protected release workflow
for annotated `v1.4.0-rc.4` with `channel=next`. Its exact-artifact, OCI, live and
representative gates remain mandatory. Paid certification requires separate
campaign approval. After Harness registry integrity and provenance verification,
run Code's protected OIDC workflow at annotated `code-v0.3.0-rc.4` on the same SHA,
with `channel=next`, `mode=oidc` and publication confirmation. Code must resolve
the real published engine without overrides and pass retained-artifact terminal
and web acceptance, four-manager checks and provenance verification. Keep stable
`latest` unchanged. The older publication records below are historical.


## Historical stable publication on 2026-10-02

Code is released independently of Harness. The recorded October 2 stable release is
`@zhivex-ai/code@0.1.0`, with the sole binary `zhivex-code`, npm tag `latest`,
and the exact dependency `@zhivex-ai/harness@1.3.0`. Harness was published and
verified first in [run 37031040747](https://github.com/Zhivex/zhivex-harness/actions/runs/37031040747). Code passed real registry
resolution, four-manager installed acceptance and source-bound provenance in
[run 37036369187](https://github.com/Zhivex/zhivex-harness/actions/runs/37036369187) at `aa86de8d700f893253559b00c1f7191e7dab48b9`.
Attempt 1 accepted publication but failed while registry metadata still reported
the version absent. Attempt 2 recovered only the failed publish job using the
retained artifact; identical bytes skipped npm publication and verification passed.
At that publication, Code `0.1.0-rc.2` remained on `next`; `0.1.0-rc.1` was historical. The existing OIDC publisher and
protected environment were preserved. See [publication evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/evidence/stable-publication-2026-10-02.json).

## Historical Code 0.2.0 preparation

That preparation used `@zhivex-ai/code@0.2.0` with the same exact published
Harness `1.3.0` dependency. Code `0.1.0` was the verified npm `latest` release
until the separately approved `0.2.0` publication. That candidate added guided
approval diffs, reviewed checkpoints, per-run estimated budgets and the offline
first-use tutorial. See the [candidate changelog](https://github.com/Zhivex/zhivex-harness/blob/main/packages/code/CHANGELOG.md)
and [release readiness](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/CODE_0_2_0_READINESS_2026-10-03.md).

That was a Code-only release: no Harness version change or new paid six-provider
certification campaign is required. Engine API tiers and provisional provider
support remain unchanged; estimated budgets are not guaranteed financial caps.

## Historical Code 0.2.0 release procedure

1. Merge the Code release PR after required review and successful checks.
2. Wait for the latest `ci.yml`, `codeql.yml` and `code-journey.yml` **push runs on main** to succeed
   for the exact commit. Keep the Code manifest, version and engine pin unchanged
   after selecting that commit.
3. Wait for Harness `1.3.0` publication and successful registry/provenance
   verification as ordered in [the Harness release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md).
   From a clean checkout of that main commit, create an annotated
   `code-v0.2.0` tag and push it. Never move or overwrite release tags.
4. Dispatch `release-code.yml` **at that tag**, with input `tag` matching it and
   `channel=latest`, `mode=oidc`, and `confirm_publication=true`. Dispatching
   main while supplying a different tag is rejected.

```sh
gh workflow run release-code.yml --ref code-v0.2.0 \
  -f tag=code-v0.2.0 -f channel=latest -f mode=oidc -f confirm_publication=true
```

The workflow validates tag identity, main ancestry, exact CI/CodeQL/installed journeys, Code source
and package boundaries. It downloads the pinned Harness version from npm and
verifies its integrity and SLSA artifact/workflow/tag/source binding; missing
publication or provenance stops the release.
It builds Code once, admits only metadata, flat built JavaScript and the two
named tutorial modules, and installs it against the actual
registry dependency without overrides, and tests the retained Code and Harness
artifacts with npm, pnpm, Yarn and Bun. The paired matrix uses explicit engine
artifact overrides; the separate standalone installation proves npm resolution.
The retained Code tarball also passes offline installed PTY journeys without
repacking. The separate `code-journey.yml` workflow runs on every PR and main
push on Linux/macOS with Node 22.13.0/24, retaining the tested tarball, digest,
report and transcript. Removing path filters ensures each selected main SHA can
produce its own journey evidence. This does not claim every future engine
version or installation order is certified.

The workflow generates genuine npm/Sigstore provenance using pinned npm 11.6.1
inside the GitHub-hosted build job. It retains `code.tgz`, `code.sigstore.json`,
`SHA512SUMS`, installed acceptance, and the offline PTY report/transcript in `code-release-<full-source-sha>`.
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
CODE_EXPECTED_SHA="$(git rev-list -n 1 code-v0.2.0)" \
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
