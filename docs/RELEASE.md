# Release process

## Current RC preparation: 2026-10-05

The source version is `1.4.0-rc.6`, pending publication to `next`.
This checkout prepares Harness `1.4.0-rc.6` and Code `0.3.0-rc.6` for npm
`next`, with Code pinned exactly to the engine and private Desktop bound to the
same Harness version. Both candidates are unpublished. Keep Harness `1.3.0`
and Code `0.2.0` on stable `latest`; published npm `next` remains Harness
`1.4.0-rc.1` and Code `0.3.0-rc.1` until a verified new publication.

RC.6 includes the reviewed activity projection fix from
[PR185](https://github.com/Zhivex/zhivex-harness/pull/185), integrated at
`be928ccb4767e2aa0f43cb45fd35b0767d3fbc0d`. Valid activity now stays within
the existing 2 MiB UI snapshot budget by compacting previews with truncation
markers while preserving run identities/statuses. Already-redacted streamed text
is split into bounded Unicode-safe events. Policy/event journals, retention,
approval authority, pairing, Host/Origin/CSRF/session protections and provider/API
tiers are unchanged; see [durable activity](LOCAL_SERVICE.md). Retain all SDK/model
pins, budgets and protected gates. Deferred performance work remains separate.

[RC.5 attempt 1](https://github.com/Zhivex/zhivex-harness/actions/runs/37384044231)
passed offline artifact/installed acceptance, live certification and all 42
representative executions, then was explicitly held before publication at the
protected npm review. Do not approve, cancel, alter or relaunch that campaign as
part of RC.6 preparation. Preserve annotated `v1.4.0-rc.5`, tag object
`f603c5739da55da0f8d8b3fa16e8fb5f27ef6f74`, at original source
`d943a2f96f11144aa0982c5db58f20d03cdc7270`; it excludes PR185. Neither RC.5
package was published and no Code RC.5 tag/release was started. Passing RC.5 evidence
is bound to that older artifact and cannot certify RC.6. Preserve the RC.4 failure,
all earlier tags/artifacts, historical preparation snapshots below and the RC.4
SDK store migration requirements.

This is version/documentation preparation only. No paid calls, tag creation,
release dispatch, publication, promotion or merge is authorized. After review and
user integration, require the latest successful `ci.yml`, `codeql.yml`,
`code-journey.yml` and `web.yml` main-push runs for the exact new RC.6 SHA plus
its direct-main CodeQL security result. Use read-only
`bun run release:prepare --sha <full-main-sha>` from that clean frozen main;
do not use `--publish` under preparation approval.

Only a new explicit campaign/publication approval can authorize annotated
`v1.4.0-rc.6` and the unchanged protected Harness workflow with `channel=next`.
Its one exact artifact, OCI, live and representative gates remain mandatory.
Independently verify actual Harness registry bytes and source-bound provenance
before the matching Code release. Under separate publication authority, Code uses
annotated `code-v0.3.0-rc.6` on the same reviewed SHA, `channel=next`, `mode=oidc`
and explicit confirmation. It must resolve the real published engine without
overrides and pass retained-artifact terminal/web and four-manager acceptance plus
registry/provenance verification. RC.5 campaign approval does not carry forward;
stable `latest` must remain unchanged.

## Historical RC.5 preparation: 2026-10-05

The source version is `1.4.0-rc.5`, pending publication to `next`. This checkout
prepares matched Harness `1.4.0-rc.5` and Code `0.3.0-rc.5`, with Code pinned
exactly to the engine candidate and Desktop bound to the same Harness version.
Keep Harness `1.3.0` and Code `0.2.0` on stable `latest`; npm `next` remains
Harness `1.4.0-rc.1` and Code `0.3.0-rc.1` until a verified publication.

RC.5 carries the reviewed process-termination test correction from
[PR183](https://github.com/Zhivex/zhivex-harness/pull/183) and the reviewed Desktop
dependency update already on main. The test covers the existing cleanup grace and
checks that the descendant stops executing; production termination is unchanged.
Retain the published RC.4 SDK batch, model pins, ceilings, acceptance checks and
protected certification gates. The new representative mapping uses the same
Meta/Qwen/OpenAI models and preserves every historical row. Existing RC.4 SDK
store migration requirements remain applicable.

[RC.4 attempt 1](https://github.com/Zhivex/zhivex-harness/actions/runs/37360365544)
failed its offline source-validation gate before retaining a release tarball.
Live certification, representative evaluation and publication were skipped;
no paid provider calls occurred. Preserve annotated `v1.4.0-rc.4`, tag object
`fc8e69a0628ca7ed1e9a0e5b2ff01473aeb0b27e`, at its original source
`f1ac8ee632d6000ec0b18d94ac2cd9a8402345e5`. That source does not contain the
reviewed test correction. Do not move the tag or treat the consumed one-campaign
approval as permission to retry it. Preserve all earlier tags, artifacts and
failed evidence; the RC.4 preparation snapshot below is historical.

This is release preparation only: no release tags, paid campaign or publication
are included. After review and integration, require the latest
successful `ci.yml`, `codeql.yml`, `code-journey.yml` and `web.yml` main-push runs
for the exact new RC.5 SHA, plus its direct-main CodeQL security result. Then use
read-only `bun run release:prepare --sha <full-main-sha>` against that clean,
frozen source; do not use `--publish` under preparation approval.

A new explicit campaign/publication approval is required before creating new
annotated tags or dispatching protected release workflows. Under that separate
approval, Harness uses `v1.4.0-rc.5` with `channel=next`; its one exact artifact,
OCI, live and representative gates remain mandatory. Verify the actual Harness
registry bytes and source-bound provenance before the independent Code release.
Code uses `code-v0.3.0-rc.5` on the same reviewed SHA, `channel=next`, `mode=oidc`
and explicit publication confirmation. It must resolve the published engine
without overrides and pass retained-artifact terminal/web acceptance,
four-manager checks and provenance verification. Preserve stable `latest`.

## Historical RC.4 preparation: 2026-10-05

The source version is `1.4.0-rc.4`, pending publication to `next`.

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


`@zhivex-ai/harness@1.3.0` is the latest public npm release. The verified `v1.3.0` publication and its exact source, registry integrity, SLSA provenance, annotated GitHub tag and release-bound live evidence are recorded in the mutable repository [release-status.json](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json), excluded from immutable npm artifacts. See [LIVE_CERTIFICATION.md](LIVE_CERTIFICATION.md).

## Verified stable publication on 2026-10-02

Harness `1.3.0` and Code `0.1.0` are published on `latest` from
`aa86de8d700f893253559b00c1f7191e7dab48b9`, through annotated tags `v1.3.0` and `code-v0.1.0`.
The [Harness run](https://github.com/Zhivex/zhivex-harness/actions/runs/37031040747) passed all exact-artifact, OCI,
six-provider live and 42/42 representative gates in attempt 1.
The [Code run](https://github.com/Zhivex/zhivex-harness/actions/runs/37036369187) verified the published Harness dependency,
standalone registry resolution and both installation orders with four managers.
Code attempt 1 accepted publication but failed verification while npm still
reported the version absent. Attempt 2 recovered only the failed publish job
with its retained tarball: identical bytes skipped publication and complete
registry/provenance verification passed. This did not rebuild or rerun paid gates.
Both retained tarballs independently matched npm SHA-512 and source-bound SLSA
provenance. Harness `next` remains `1.3.0-rc.7`; Code `next` remains `0.1.0-rc.2`.
See [publication evidence](reports/evidence/stable-publication-2026-10-02.json); historical attempts and the previous
verified latest record are preserved there and in Git history.

The user authorized one campaign estimated at US$25 without an automatic
monetary cap, with no paid reruns. No paid reruns occurred. Actual invoiced cost
is unavailable in retained evidence. Desktop stays private alpha, beta and
experimental contracts retain their tiers, and Anthropic/Gemini/Vertex remain
provisional with no representative-matrix or feature-parity claim.

## Historical Harness 1.3.0 and Code 0.1.0 stable preparation

The source version is `1.3.0`, targeting npm `latest` through annotated tag
`v1.3.0`. Code `0.1.0` pins exactly Harness `1.3.0` and targets `latest` through
`code-v0.1.0`. This closure introduces no new product features. Stable version
numbers preserve the recorded API tiers, provisional Anthropic/Gemini/Vertex
support and private Desktop `0.1.0-alpha.1` status.

Harness RC7 was published on `next` after [run 36852432470](https://github.com/Zhivex/zhivex-harness/actions/runs/36852432470)
passed artifact, live and representative gates. Code RC2 was published on `next`
with registry resolution and provenance in [run 36902929707](https://github.com/Zhivex/zhivex-harness/actions/runs/36902929707).
RC6/earlier failed campaigns stay failed. Registry-propagation verification
retries do not represent a product fix or certify the stable bytes.

### Exact order after review and new approval

The following commands are the pending operator procedure, **not permission to
execute it during PR preparation**. Merge, release tags, publication and paid
workflow dispatch all require fresh approval; RC5 approvals do not carry over.

1. Review and merge the PR; wait for the latest `ci.yml` and `codeql.yml` main
   push runs on the selected full merge SHA. Use the existing cloud checkout.
2. From that clean `main` checkout run read-only Harness preparation:
   `bun run release:prepare --sha <full-main-sha>`. No tag or workflow is created.
3. After explicit approval for the stable campaign/publication run
   `bun run release:prepare --sha <full-main-sha> --publish`. This creates or
   verifies the immutable annotated `v1.3.0` tag and dispatches `release.yml` at
   that tag with `tag=v1.3.0`, `channel=latest`, `confirm_publication=true`.
4. Require every exact-artifact, OCI, six-route live and representative gate to
   pass, protected npm approval, registry integrity and source-bound provenance.
   Wait until Harness `1.3.0` is actually published and verified on `latest`.
5. At the same reviewed SHA, create and push the independent annotated Code tag:
   `git tag -a code-v0.1.0 <full-main-sha> -m 'Release Code 0.1.0'`, then
   `git push origin refs/tags/code-v0.1.0`. Do not overwrite an existing tag.
6. Dispatch Code with the existing protected Trusted Publishing configuration:

```sh
gh workflow run release-code.yml --repo Zhivex/zhivex-harness --ref code-v0.1.0 \
  -f tag=code-v0.1.0 -f channel=latest -f mode=oidc -f confirm_publication=true
```

7. Require the Code workflow to download the real Harness `1.3.0` tarball,
   verify engine identity/integrity/provenance, test standalone registry resolution
   without overrides and installed four-manager acceptance, publish only its
   retained tarball, then verify Code `latest`, exact bytes and provenance.
8. Only after both verifications update the mutable publication record and
   current release/support wording to the observed registry outcome. Preserve
   the historical record and all failed attempts. If publication succeeded but
   verification is pending, retry verification/the failed publish job using its
   original retained bytes; do not rebuild, move tags or rerun paid gates merely
   for registry propagation.

### What can pass before Harness exists in the registry

PR CI and local checks build Harness, explicitly link the built public package
for Code contributor compilation, and pack both unchanged stable manifests.
The installed local/global matrix uses exact supplied tarballs and explicit
consumer overrides or a read-only loopback registry fixture. This validates
versions, export contracts, launchers, both install orders, approvals, execution
and state behavior without paid calls. It does not verify public availability or
registry provenance. The Harness release gate likewise tests its exact tarball
with Code before publishing Harness, so there is no dependency publication cycle.

Code `engine` and `smoke-registry` deliberately require the **published** exact
Harness version. They remain blocked before step 4 and are mandatory in step 7;
local acceptance never bypasses or replaces them.

### Live scope and proposed spending boundary

A single new Harness campaign uses Meta `muse-spark-1.3-contributor`, Qwen
`qwen3.8-flash`, OpenAI `gpt-6-luna`, Anthropic `claude-sonnet-5-5`, Gemini API
`gemini-3.6-flash` and Vertex `gemini-3.7-flash` for base approval/restart,
approval compaction, structured reviewer delegation, model-directed OCI execution
and multi-process conversation continuity. Four mixed routes are OpenAI to
Vertex/Anthropic/Gemini and Qwen to Meta. Representative evaluation is **only**
Meta/Qwen/OpenAI: seven fixtures, clean and hostile variants, one repetition,
42 cases total. Six-route live success does not establish representative coverage
or feature parity for Anthropic/Gemini/Vertex.

Proposed approval scope: **one Harness campaign, no paid reruns**, with an
operator budget ceiling of **US$25 total**, monitored in provider billing. This
is a proposed limit, not a price estimate or a workflow-enforced dollar cap:
current scripts bound steps/tokens/time, but do not enforce aggregate invoiced
USD across providers. If a hard dollar cap is required, approval remains blocked
until the operator confirms an existing enforceable provider budget; no credential
or IAM/budget changes are authorized here. Do not infer permission to spend from
RC5 or prior paid campaigns. Code release gates make no live-provider calls;
GitHub/npm/registry authentication is separate from model spend. No paid calls
were made during preparation.

### Historical RC7 preparation

RC7 retained the RC5 model pins, zero Qwen smoke sampling temperature, distinct
resume/compaction/continuation diagnostics and unchanged application defaults.
Its successful evidence remains bound to `23978731d84712972ad47dfd65ce9255872f8246`.

### Protected configuration before RC7 release

The `live-certification` environment requires secrets `OPENAI_API_KEY`,
`MODEL_API_KEY`, `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`), `ANTHROPIC_API_KEY`
and `GEMINI_API_KEY`. Optional route settings use the existing provider-specific
base URL, Qwen region and workspace secrets. A presence-only preflight rejects
missing configuration before paid gates and prints names, never values.

Configure environment variables `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`,
`VERTEX_WORKLOAD_IDENTITY_PROVIDER` and `VERTEX_SERVICE_ACCOUNT`. The pinned
Google auth action creates short-lived ADC via GitHub OIDC; the identity must be
authorized for this repository and protected environment and for the selected
Vertex route. Local user ADC is not copied to GitHub. Auth-generated credential
files are ignored and never included in artifact uploads. The job requires
`id-token: write`; authentication failure blocks every subsequent paid gate.

The Vertex WIF condition must admit future canonical release tags rather than
enumerating individual RC refs. Generate the reviewed condition with
`bun run scripts/vertex-release-identity.ts`. It requires the repository and
owner numeric IDs, the protected `live-certification` environment subject,
`workflow_dispatch`, a canonical `vX.Y.Z` / `vX.Y.Z-rc.N` tag and an exact
workflow/ref binding for `release.yml` or `live-certification.yml`. Branches,
pull requests, other workflows, environments and repositories remain excluded.
Apply this condition to the configured provider through an authorized IAM
change, retain the previous condition for rollback and re-read it afterwards.
Presence checks do not verify IAM; successful GitHub OIDC authentication remains
required before paid provider gates. Local cloud access is not GitHub identity
certification.

Manual live certification defaults to all six routes and runs the same base,
approval compaction, structured delegation, mixed routing, OCI execution and
conversation continuity gates as the release. A diagnostic provider subset
limits the per-provider gates; the four fixed mixed routes still require the
complete six-route configuration and Vertex authentication. Manual evidence
does not replace the release-bound representative matrix or published-byte
verification.

The execution smoke uses a host-owned `live-execution-fixture.mjs` in the OCI
snapshot. The model must submit the exact reviewed `node` argv, inspect its
patch and obtain separate host-import approval. Certification checks the final
provider file, unchanged fixture, execution binding, tool sequence and unique
journal entries. Keeping JavaScript out of the model-authored argv avoids false
failures from source rewriting without accepting arbitrary programs.
Continuity emits one sanitized JSON envelope per campaign, preserving provider,
failed phase, allowlisted failed checks and typed provider diagnostics in the
aggregate gate; raw conversation and provider output remain excluded.

The previous `v1.3.0-rc.1` attempt failed the Qwen base certification because
its pending `apply_patch` proposal ID differed from the expected ID. npm was
never invoked. RC2 validates proposal digests before requesting approval, so an
invalid model call receives an input error rather than an unusable approval.
The exact live assertion and provider cohort remain unchanged; the historical
tag and artifact are not moved or rewritten.

## RC3 operator decision

After complete local validation, the corrected artifact passed OpenAI 14/14 and
Qwen 14/14; Meta passed 13/14 and returned HTTP 504 `server_error` in the remaining
SQLite case. No unauthorized effects occurred and the process exited naturally.
The operator explicitly authorized advancing the RC despite this provider-side
HTTP failure. The precise upstream internal cause remains unknown.

This authorization permits preparing and uploading RC3; it does not turn 41/42
into full certification. The current protected workflow has no failure waiver:
publication still requires successful exact-artifact validation, live gates,
representative matrix and environment approval. Historical RC1/RC2 tags remain
unchanged. See the [local campaign](reports/RC2_RECOVERY_REPRESENTATIVE_2026-09-28.json).

## Recovered proposal certification

A schema rejection before approval is a result receipt, not a workspace execution.
The base gate snapshots persisted results before resume and allows only retained
`TOOL_INPUT_VALIDATION_ERROR` receipts with the same tool-call IDs. New errors,
missing or duplicated receipts, execution failures, and results for an unapproved
call remain failures. No apply-patch journal entry may exist before approval;
after resume there must be one successful result for the approved call, one
completed journal entry, and the exact expected file content.

The deterministic proposal-recovery test runs the same effect assertion after
closing and reopening the durable store. This connects the runtime's recovery
contract to the release gate instead of testing each in isolation. It does not
replace full artifact live and representative certification.

## Deterministic gates

From a clean checkout on `main`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun install --cwd desktop --frozen-lockfile --ignore-scripts
# macOS: the full test suite also exercises the native Desktop worker.
if [ "$(uname -s)" = Darwin ]; then
  node desktop/node_modules/electron/install.js
fi
bun run release:check
git diff --check
git status --short
```

`bun run release:check` performs documentation validation, typechecking, deterministic tests, the golden evaluation gate, the required real-OCI boundary gate, a dependency-externalized build, package-content validation, clean tarball installation, direct binary execution, public import, SDK execution-environment import, SQLite restart/resume, redacted inspection, exactly-once side-effect verification, dependency audit, untrusted lifecycle-script inspection, dry-run packing, and release metadata validation.

Contributor builds use TypeScript 7.0.2. The separate `typescript-compiler-api`
alias intentionally stays on TypeScript 6.0.3: architecture and Stable API
signature checks depend on its JavaScript compiler API, which the TypeScript 7
package root does not expose. Upgrade this alias only alongside a validated
migration of both checks.

CI repeats the deterministic and installed-package gates on Linux and macOS. Build output is ignored and must not create tracked changes.

## Live gate

Provider behavior is certified separately because it is credential-, account-, model-, endpoint-, and date-dependent:

```bash
export ZHIVEX_HARNESS_LIVE_META_MODEL=muse-spark-1.3-contributor
export ZHIVEX_HARNESS_LIVE_QWEN_MODEL=qwen3.8-flash
export ZHIVEX_HARNESS_LIVE_OPENAI_MODEL=gpt-6-luna
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:orchestration
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:routing
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:execution
ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run smoke:oci
```

The base reviewed-edit gate and the separate delegation gate must pass for every provider in the supported release matrix. The release workflow additionally requires the mixed-provider route, model-directed execution, and representative repository gates against the exact annotated tag before the npm job can start; deterministic OCI enforcement remains a separate prerequisite. Gemini is explicitly provisional and excluded from the 1.0 cohort under [GEMINI_1_0_DECISION.md](./GEMINI_1_0_DECISION.md). Integrated provisional providers must not be described as certified. `bun run check` also runs controlled Streamable HTTP MCP interoperability gates; each external implementation claim remains bounded to the tested server/version. See [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).

## Exact artifact gate

The release workflow performs this sequence across an unprivileged validation job and a protected publication job:

1. check out an existing annotated `v<package-version>` tag with complete history;
2. prove that the tag resolves to `main`, the worktree is clean, and the version is absent from npm;
3. run the complete release gate with Bun-managed contributor tooling and the supported Node runtime;
4. create one tarball with `bun pm pack --ignore-scripts`;
5. allow only the documented package roots, verify the packed manifest, and write `SHA512SUMS`;
6. install that same tarball in an isolated consumer and execute its CLI and public API;
7. extract the validated tarball and run the protected base, orchestration, routing, and model-directed OCI live gates through its public runtime; require the artifact path and matching version, including approval child processes;
8. run the 14-case governed representative repository matrix for Meta, Qwen, and OpenAI against the same artifact binding and one digest-pinned OCI image; reject missing/selective/unsafe runs and upload only the strict sanitized evidence document;
9. transfer only the tarball and `SHA512SUMS` into the `npm` environment, then revalidate the checksum and artifact contract;
10. pass that same file to the npm CLI for the registry transaction; and
11. retry within one absolute five-minute deadline through registry and attestation propagation, capping every request and sleep by the remaining time, then verify the distribution tag, byte-identical SHA-512 integrity, and SLSA subject/repository/workflow/ref/commit evidence. The ref must be `main` or the exact `v<package-version>` tag; arbitrary branches and tags fail closed.

For a local artifact rehearsal after the source gate:

```bash
mkdir -p release-artifacts
HARNESS_VERSION="$(node -p 'require("./package.json").version')"
HARNESS_ARTIFACT="release-artifacts/zhivex-ai-harness-${HARNESS_VERSION}.tgz"
bun pm pack --filename "$HARNESS_ARTIFACT" --ignore-scripts
bun run artifact:check -- "$HARNESS_ARTIFACT"
bun run smoke:artifact -- "$HARNESS_ARTIFACT"
```

The manual tag-bound live-certification workflow runs `bun run build` immediately before packing. This is required because its readiness preflight validates source and release identity but does not create `dist/`; a source-only tarball is not valid release evidence.

`release-artifacts/`, `.npmrc`, `.env`, source tests, Git metadata, and local run state are excluded from the package. Development reports under `docs/reports/` and historical benchmark JSON under `benchmarks/baselines/` also remain repository-only archives. Published guides link to those archives; artifact validation rejects accidentally bundled copies.

## External prerequisites

Before a release dispatch, reverify repository/package visibility compatibility, protected-environment reviewers, package ownership with 2FA, and that the Trusted Publisher identity matches the repository workflow. Do not rely on a previous release's state.

The release workflow intentionally supplies no long-lived registry token. Do not introduce one as a fallback; a failed OIDC assertion is a stop condition to diagnose.

Trusted Publishing currently requires npm CLI `11.5.1` or newer and Node `22.14.0` or newer. The workflow follows npm's current Node 24 guidance and uses npm only for the OIDC/provenance-aware registry transaction. Dependency management, tests, and packing use Bun as contributor tooling; the built CLI, public library, SQLite reopen, and installed artifact execute under Node.

## Release preparation preflight

Run `bun run release:preflight` to check the candidate's dated changelog and
representative tag/model mapping before expensive gates. CI runs this check with
`--allow-unreleased`: development headings remain valid, while dated candidates
must include an exact certification mapping consistent with the release workflow.
The protected release additionally checks tag, channel, source identity and registry
absence before pulling the OCI image or running the deterministic suite.
Dependency audits use the same bounded transient-outage retry policy as CI;
vulnerabilities and other errors still fail immediately.

From a clean `main` checkout at the intended remote commit, after CI and CodeQL:

```bash
# Read-only; replace the placeholder with the full reviewed main commit SHA.
bun run release:prepare --sha <full-main-sha>
# Explicitly confirm creation of the annotated tag and protected publication.
bun run release:prepare --sha <full-main-sha> --publish
```

The command derives version and channel from `package.json`, requires the latest
main push runs of CI and CodeQL to have passed for that exact SHA, and rejects
an active release for the same SHA. It never moves existing tags: an existing
annotated tag must resolve to the same commit. Creation uses an atomic ref create;
a competing creation fails rather than overwriting it. Dispatch uses the exact tag
to avoid a concurrent main update selecting a different workflow commit. The
protected workflow retains all artifact, live, representative and OIDC gates.
The default preflight does not certify live providers or publish anything.

Validated tarballs and checksums are retained for 30 days for exact-byte recovery.
The workflow summary reports every gate; the registry transaction summary separates
verified publication, accepted publication pending verification, and a failed
transaction whose registry acceptance is unknown. A failed publication command
must not be interpreted as proof that npm did not accept the version. If the
artifact has expired, stop and recover the original bytes and evidence rather than
rebuilding an already accepted version.

## Tag and dispatch

After review and merge, maintainers create an annotated `v<package.json version>` tag from the exact release commit and dispatch the protected workflow with that tag plus an explicit publication confirmation. The workflow YAML contains no release-version default: `package.json` is the source of version truth, and the required tag input is validated against it before publication. Manual dispatch may use `main` only while it equals the tagged commit. The preparation command dispatches the exact annotated tag after proving it matches reviewed remote `main`; the workflow verifies the checkout equals its dispatch SHA and remains reachable from `origin/main`.

The confirmation is intentional because registry versions are immutable, and the protected environment adds a second human approval boundary. Do not use a local registry session or manual upload as an alternate path.

Release candidates use versions and annotated tags such as `1.0.0-rc.1` / `v1.0.0-rc.1` and must publish to `next`. Stable versions must publish to `latest`; the readiness gate rejects either channel mismatch before registry mutation. The representative assembly matrix explicitly authorizes RC.1 through RC.14 and the final `v1.0.0` tag and pins the Meta, Qwen, and OpenAI model for each, so both candidate and stable publication execute the exact unpacked tarball runtime rather than a checkout-only build. Failed immutable attempts remain in the readiness ledger but do not count toward GA. Before any `1.0.0` dispatch, `bun run readiness:1.0:release` must pass. That gate requires two complete passing RC records, current security and representative evaluation evidence, historical migration fixtures, and no open GA blocker. Release execution stops subsequent gates and providers after a confirmed failure; bounded transient retries inside a gate are unchanged. Representative evaluation starts only after live certification succeeds. The final aggregate and sanitized diagnostic upload always run, and skipped gates never count as passed. Manual live certification retains exhaustive diagnostics; standalone live smoke scripts enable release behavior with `ZHIVEX_HARNESS_LIVE_FAIL_FAST=1`. Every live/OCI phase, including image preload, runs through its own diagnostic wrapper. Failed jobs upload only bounded, strict-schema outcomes self-bound to the release tag, source commit, canonical tarball SHA-512, workflow run, and `github.run_attempt`; representative diagnostics additionally bind provider/model, driver commit, and OCI image digest. Cross-provider identity drift, a missing binding, or an incoherent passed/failed state is treated as unavailable evidence. Raw child stdout/stderr is not relayed, and raw prompts, provider output, error messages, response bodies, headers, credentials, run identifiers, and stacks remain excluded. See [GA_READINESS.md](./GA_READINESS.md), [ROLLBACK.md](./ROLLBACK.md), and [DEPRECATIONS.md](./DEPRECATIONS.md).

If npm accepted the immutable version but the post-publication verifier failed during propagation, rerun only the failed `publish` job. It downloads the already validated artifact, skips `npm publish` only when the registry version has byte-identical integrity, and repeats the registry/provenance verification. Never rebuild, bump, or republish the same version to recover a post-publication false negative.

## Publication stop conditions

Do not dispatch or approve publication when any of these is true:

- the repository is not public, the tag is not annotated, the tagged commit is not on `main`, or the worktree used to create it was dirty;
- deterministic, installed-artifact, required live-provider, representative-repository, or release-artifact evidence failed;
- package scope ownership, 2FA, the intended `public` access level, or the protected environment is unclear;
- the inspected package contents and the to-be-published artifact are not the same file;
- the package version already exists in npm;
- an npm token or `NODE_AUTH_TOKEN` has been reintroduced into the OIDC-only workflow;
- Trusted Publishing is expected but its repository, workflow filename, environment, or allowed action disagrees with the workflow; or
- version, changelog, tag, registry metadata, source commit, integrity, or provenance disagree.

Current npm requirements should be revalidated against the official [Trusted Publishing guide](https://docs.npmjs.com/trusted-publishers/), [provenance guide](https://docs.npmjs.com/generating-provenance-statements/), and [Bun packaging documentation](https://bun.com/docs/pm/cli/publish) before any registry mutation.

Representative diagnostics checkpoint completed cases atomically after each case. A later report or cleanup failure retains those results and adds a terminal failure with its exact phase; it does not reset the matrix to zero. Semantic failure classifications and their original Harness wrappers are retained independently. Error details contain only a bounded chain of allowlisted error kinds/system codes, HTTP status numbers and retryability, plus validation issue counts and allowlisted issue types. Messages, validation paths/inputs, arbitrary codes, headers, response bodies and stacks are never copied. Fingerprints identify the sanitized structure, not a unique raw exception.

Representative drivers emit bounded checkpoints on a separate pipe to the benchmark
supervisor. A hard timeout retains the last phase (runtime/provider setup, harness
creation, agent, approval, verification, close, evidence or cleanup), last allowlisted
event, elapsed/phase time and step/tool counters in `failure.details.benchmarkProgress`.
The release summary displays that checkpoint. It is the last observed activity,
not proof of the underlying cause. Raw event payloads and stderr are never copied.
Malformed, oversized or unknown checkpoint fields are ignored. The built-in driver
reserves up to 30 seconds inside the unchanged outer deadline for timeout handling,
verification and cleanup; the supervisor still fails and kills the driver at its
hard deadline if it cannot finish. Historical diagnostics without checkpoints remain valid.

Benchmark checkpoints also retain up to 24 operation spans and 16 phase transitions.
Spans distinguish model generate/stream calls, time to first text delta, transport
attempts (HTTP status and parent model-call number), allowlisted tool execution,
and OCI image inspection, container creation, execution/attestation, export and
cleanup. Transport timing ends at response headers; stream timing includes body
consumption. Multiple transport attempts are observable, but their count alone
does not prove an SDK retry. Tool names outside the allowlist become `other_tool`.

Each checkpoint includes configured supervisor/agent/tool budgets, remaining total
time, and a timeout scope only when the supervisor, agent status or OCI result
confirms it. Setup time and repeated agent resumes may still exhaust the outer
budget first. Active spans continue aging in the supervisor after the last event.
Failed normal driver results retain their final checkpoint as well as hard-kill
failures. Actions includes a bounded per-case table with the last active operation,
inactivity, expired budget and a link to the run's diagnostic artifacts. The trace
is a bounded observation history, not a raw request log or a complete profiler.

Provider failure diagnostics apply to every provider using the shared model/HTTP
observer, including Meta, Qwen, OpenAI and Gemini. Rejected HTTP responses retain
only a fixed reason, allowlisted parameter, and body inspection state. Parsing is
limited to 8 KiB and 250 ms, preserves the original response for the SDK, and never
logs bodies, headers, URLs or messages. Unknown provider formats remain explicitly
unknown; these labels are classifications, not verbatim server explanations.
The most recent provider rejection survives span eviction and a later stream error.
Wrapped runtime errors also project the same structured provider fields into their
sanitized cause chain, including live gates outside the representative benchmark.

Driver lifecycle checkpoints distinguish `cleanup`, `cleanup_complete`,
`result_write`, `result_written` and `exit_pending`. After stdout is flushed, an
unreferenced one-second observer reports whether the process is still alive; it
cannot keep the process alive itself. Node reports bounded resource-type counts
without handle contents. Bun currently does not implement the resource inventory,
so it explicitly reports `unsupported` rather than claiming no resources remain.
A supervisor timeout after a valid failed result retains the original sanitized
failure chain as well as the supervisor timeout; it never turns that run into a pass.
The Actions failed-case table includes the provider rejection and resource inventory.

### OCI patch mismatch diagnostics

The OCI runtime persists the last inspected patch ID in its private, identity-bound
execution metadata before returning an inspection. This optional diagnostic receipt
survives approval restart; older artifacts without it remain readable. Import still
recomputes the full patch and checks the approved ID and host preconditions. The
receipt cannot authorize or substitute different bytes.

Sanitized release diagnostics distinguish `OCI_PATCH_ID_MISMATCH` (the current patch
still matches the last inspection, but the submitted ID does not),
`OCI_PATCH_SNAPSHOT_CHANGED` (the submitted ID matches that inspection, but the
current patch differs), and `OCI_PATCH_REVIEW_UNAVAILABLE` (missing or ambiguous
inspection evidence). A changed execution identity/binding is reported separately
as `OCI_EXECUTION_BINDING_CHANGED`. No digest values, paths, contents or tool
arguments are included in these diagnostics. Patch mismatches retain the
`PATCH_DRIFT` classification across sanitized child-process serialization.

A rejected import leaves the host unchanged. Recovery requires inspecting the
current patch and obtaining a new approval for that exact ID; do not rewrite a
pending approval or retry the old ID automatically. A terminal
`apply_environment_patch` call with a typed `OCI_PATCH_ID_MISMATCH` may return to
the model once per run with instructions to inspect again and request a fresh
approval. The failure receipt survives pause/resume, so resuming does not reset
that limit. Changed snapshots, unavailable review evidence, binding changes and
unknown effects remain terminal. No pending approval is rewritten.

The `v1.2.0-rc.1` attempt
([run 36204796627](https://github.com/Zhivex/zhivex-harness/actions/runs/36204796627))
passed exact-artifact validation and live gates, then stopped on Qwen's clean
`python-pytest-repository` case at `apply_environment_patch` with `PATCH_DRIFT`.
Meta passed 14/14, Qwen passed 13/14, and OpenAI and publication were skipped.
The historical diagnostics recorded zero unauthorized effects but did not retain
the inspection comparison, so they cannot establish which mismatch occurred.
Do not reinterpret that attempt as passing or attribute it to provider availability.

### Product and artifact coverage

Release and manual live workflows set `ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT=1`
and `ZHIVEX_HARNESS_LIVE_RUNTIME` to the extracted, inspected tarball. The base,
orchestration, routing and model-directed execution smokes load their Harness
functions, descriptors and error types from that runtime. A missing artifact,
wrong version or missing export fails before requests; local development alone
may fall back to source. The separate deterministic OCI smoke remains a source
boundary check.

Desktop CI packages the macOS application and exercises startup, approval/history
restart, interruption between an effect and its receipt, active-run cancellation,
and isolated worktree delivery/reconciliation. Closing with active work must offer
stay/cancel before awaiting an IPC that itself depends on that work finishing.
Accepted application operations still drain before hosts are closed. These are
fixture-backed product journeys, not live-provider or signed Desktop distribution
certification.

The complete representative matrix remains blocking and unchanged. The focused
[Python follow-up](reports/RC1_PATCH_FOLLOWUP_2026-09-26.json) is diagnostic evidence only; it cannot replace the full
cohort or certify a new release. It also predates the performance backport from
`95aee33`; the combined artifact requires its own complete live certification.

### Diagnosing reviewed-edit resume failures

The base live gate records separate checkpoints for `resume_result_count`,
`resume_result_success`, `resume_file_read`, `resume_file_content`,
`resume_journal_read`, `resume_journal_count`, and `resume_journal_status`.
Sanitized `editEffect` counters distinguish result receipts (successful or error)
from durable journal entries and completed entries. An error receipt alone does
not establish that a filesystem mutation executed. These are diagnostics, not
relaxed acceptance: the gate still requires exactly one successful write result,
exact expected file content, and exactly one completed journal entry.

RC6 failed at the earlier grouped `resume_effect` checkpoint before publication.
Its evidence cannot retrospectively identify which assertion failed; a later
successful local reproduction does not certify that failed release run.

### Pending OCI delivery diagnostics

The RC7 attempt failed the clean `hostile-instructions` case after editing and
running a command without importing the isolated patch. Its historical
`VERIFIER_FAILED` diagnostic is unchanged. New builds detect this boundary before
completion and distinguish `OCI_DELIVERY_PENDING`, `OCI_DELIVERY_DECLINED`, and
`OCI_DELIVERY_INSPECTION_FAILED`. Detection compares actual snapshot and host
contents/modes, including previously imported paths. It does not waive the final
verifier or grant import approval.

### Provider failure shutdown checks

Meta stream setup failures must retain the original provider error and exit
naturally without waiting for the model deadline. The adapter owns deadline
cleanup across setup and iterator termination. Subprocess regressions cover
HTTP/transport failures, stream errors, cancellation and deadlines; the installed
package smoke checks the same failure boundary under Node. A valid result on
stdout alone is not successful driver completion.

Desktop smoke retains a 90-second watchdog and records phase timing in
`progress.json`; renderer operations and failure snapshots have bounded waits.
A watchdog failure must include its evidence directory and last phase.
