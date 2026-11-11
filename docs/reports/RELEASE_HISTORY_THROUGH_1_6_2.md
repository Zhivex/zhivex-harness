# Release preparation and decision history through 1.6.2

Archived from `docs/RELEASE.md` on 2026-11-11. The sections below preserve
their original versions, pending states, authorizations, failures and validation
limits. They are historical records, not instructions or authorization for a new
release. Use the [current release procedure](../RELEASE.md) for operations and
the [report index](README.md) for publication evidence.

## Published patch: 1.6.2

Harness `1.6.2` is published on npm `latest`. It carries the
1.6.1 changes plus the continuity gate rule from #250. Three live certifications
failed only the continuity gate, each on a different provider (`v1.6.0`: meta
and qwen; `v1.6.1`: meta, then openai on the rerun). A provider whose
continuity run fails now gets one fresh retry of all phases. It passes only if
the retry passes, and all selected providers stay mandatory. The evidence
records each retry and the first attempt's sanitized cause. `v1.6.0` and
`v1.6.1` stay tagged and were not published. Code stayed version `0.4.0` in this
release, with its source pin on Harness `1.6.2`. Private Desktop binds to Harness `1.6.2`. It adds
the `v1.6.2` representative mapping with the same Meta, Qwen and OpenAI models
as `v1.6.1`. Annotated `v1.6.2` on the reviewed main SHA, `channel=latest`, ran
through the unchanged protected workflow and its environment approvals (run
40100307698, completed 2026-10-24). Code `0.4.1`, pinned exactly to Harness
`1.6.2`, was then published on `latest`; see [CODE_RELEASE.md](../CODE_RELEASE.md).

## Previous preparation: 1.6.1

The source version was `1.6.1`, pending publication to `latest`. It carries the
1.6.0 changes plus the compaction chronology fix from #248, which addresses the
meta and qwen continuity gate failures in the `v1.6.0` live certification.
`v1.6.0` stays tagged and was not published. Code stays version `0.4.0` and its
source pin is Harness `1.6.1`. Private Desktop binds to Harness `1.6.1`. It adds
the `v1.6.1` representative mapping with the same Meta, Qwen and OpenAI models
as `v1.6.0`. Annotated `v1.6.1` on the reviewed main SHA, `channel=latest`, runs
through the unchanged protected workflow and its environment approvals. Its live
certification failed the continuity gate twice (meta, then openai), so 1.6.1 was
not published.

## Previous preparation: 1.6.0

The source version was `1.6.0`, pending publication to `latest`. That checkout
prepared Harness `1.6.0` for npm `latest`. Code stays version `0.4.0`. Its
source pin is Harness `1.6.0` because installed acceptance requires that exact
match. Published npm Code `0.4.0` remains pinned to Harness `1.5.0` and is not
part of this release. Private Desktop binds to
Harness `1.6.0`. Published `latest` is Harness `1.5.0` and Code `0.4.0`. It adds
the `v1.6.0` representative mapping with the same Meta, Qwen and OpenAI models
as `v1.5.0` and does not change provider/API tiers. The minor is opt-in
auto-approve: `manual` stays the default, and `auto-edits` and `auto-limits`
still ask for network, secrets, git push, publish, and writes outside the
workspace. Annotated `v1.6.0` on the reviewed main SHA, `channel=latest`, runs
through the unchanged protected workflow and its environment approvals. This
preparation creates no tag and dispatches no workflow. Its live certification
failed the continuity gate, so 1.6.0 was not published.

## Previous preparation: 1.5.0

The source version was `1.5.0`, pending publication to `latest`. That checkout
prepared Harness `1.5.0` and Code `0.4.0` for npm `latest`, with Code pinned
exactly to that engine and private Desktop bound to the same Harness version.
Published `latest` is Harness `1.4.1` and Code `0.3.2`. It adds the `v1.5.0`
representative mapping with the same Meta, Qwen and OpenAI models as `v1.4.1`
and does not change provider/API tiers. Annotated `v1.5.0` then `code-v0.4.0`
on the same reviewed main SHA, `channel=latest`, run through the unchanged
protected workflows and their environment approvals. That preparation does not
certify 1.6.0.

## Pending patch: 1.4.1

The source version is `1.4.1`, pending publication to `latest`.
This checkout prepares Harness `1.4.1` and Code `0.3.1` for npm `latest`, with
Code pinned exactly to the engine and private Desktop bound to the same Harness
version. Both patch versions are unpublished. Published `latest` is Harness
`1.4.0` and Code `0.3.0`. Published npm `next` is Harness `1.4.0-rc.8` and Code
`0.3.0-rc.8`. The mutable `release-status.json` records the verified Harness 1.4.0
`latest` publication. Do not rewrite it to `1.4.1` until that publication has its own
registry integrity, provenance and release-bound live evidence.

The Vertex transient-failure classification and explicit output caps above 2,048
shipped in 1.4.0. This patch keeps the narrow composer readable, says when an
operation was rejected, shows web limits in English, hides the Node 22 SQLite
warning, checks the Node engine at startup, and describes command reviews as
commands. A local web reconnect that overlaps a finishing command reads durable
state again so reconciliation can enable the next session. That patch pinned
Core 1.33.0. Unreleased Bedrock and Azure OpenAI routes pin Core 1.34.0,
`@zhivex-ai/bedrock@2.0.7`, and `@zhivex-ai/azure-openai@0.7.8`.
Anthropic is 0.14.0, OpenAI is 0.16.0 and Vertex is 1.2.7, because Vertex 1.2.7
requires those OpenAI and Anthropic ranges. Agents stays 1.11.0, Qwen 0.16.4,
Meta 0.2.9 and Gemini 0.13.0. The development MCP server package is 2.3.1.
Optional `@napi-rs/keyring` is 2.1.1 in Harness and Code. Maintenance updates are ACP SDK
1.8.0, `@types/node` 26.6.5, CodeQL Action 4.38.3, setup-node 7.1.0,
upload-artifact 7.0.2 and download-artifact 8.0.2. Dependabot updates for
private Desktop are paused.

This preparation adds the `v1.4.1` representative mapping with the same Meta,
Qwen and OpenAI models as `v1.4.0` and does not change provider/API tiers.
Stable package numbering does not upgrade beta or experimental tiers. Desktop
stays private alpha.

This is version and documentation preparation only. No paid calls, tag creation,
release dispatch, publication, promotion or merge is authorized. After review and
user integration, require the latest successful `ci.yml`, `codeql.yml`,
`code-journey.yml` and `web.yml` main-push runs for the exact new patch SHA plus
its direct-main CodeQL security result. Use read-only
`bun run release:prepare --sha <full-main-sha>` from that clean frozen main;
do not use `--publish` under preparation approval.

Only a new explicit campaign and publication approval can authorize annotated
`v1.4.1` and the unchanged protected Harness workflow with `channel=latest`.
Its one exact artifact, OCI, live and representative gates remain mandatory.
Independently verify actual Harness registry bytes and source-bound provenance
before the matching Code release. Under separate publication authority, Code uses
annotated `code-v0.3.1` on the same reviewed SHA, `channel=latest`, `mode=oidc`
and explicit confirmation. It must resolve the real published engine without
overrides and pass retained-artifact terminal/web and four-manager acceptance plus
registry/provenance verification. The unpublished 1.4.0 preparation does not
certify 1.4.1 or 0.3.1.

## Previous stable preparation: 2026-10-09

The source version is `1.4.0`, pending publication to `latest`.
This checkout prepares Harness `1.4.0` and Code `0.3.0` for npm `latest`, with
Code pinned exactly to the engine and private Desktop bound to the same Harness
version. Both stable versions are unpublished. Published `latest` stays Harness
`1.3.0` and Code `0.2.0`. Published npm `next` is Harness `1.4.0-rc.8` and Code
`0.3.0-rc.8`. The mutable `release-status.json` keeps the verified Harness 1.3.0
`latest` record. Do not rewrite it to `1.4.0` until that publication has its own
registry integrity, provenance and release-bound live evidence.

Annotated tags `v1.4.0-rc.8` and `code-v0.3.0-rc.8` both resolve to
`5bba06c86fc82b34b67cec607053948f8e00d0d1`. A diff of that commit against main
`734e5b8b090562d5b00bb24ada5adef8068c74c9`, before this version bump, shows:

- Engine runtime source under `src/` is identical. Root `scripts/`, root `tests/`
  and `evaluations/` are also identical to that tag.
- `packages/code` is not identical. It includes the shared review screen for
  shell `--continue` and `/pending`
  ([PR201](https://github.com/Zhivex/zhivex-harness/pull/201)), the status line,
  one-line summary and 48×24 first-welcome logo
  ([PR210](https://github.com/Zhivex/zhivex-harness/pull/210)), and the public
  package README ([PR200](https://github.com/Zhivex/zhivex-harness/pull/200)).
- `packages/web` is not identical. It includes the B-lite review scope
  ([PR211](https://github.com/Zhivex/zhivex-harness/pull/211)).
- `desktop` is not identical. It includes removal of the fixture waiting button
  ([PR203](https://github.com/Zhivex/zhivex-harness/pull/203)) and the same
  B-lite review scope ([PR211](https://github.com/Zhivex/zhivex-harness/pull/211)).
- Packaged Harness docs also differ: `README.md`
  ([PR200](https://github.com/Zhivex/zhivex-harness/pull/200)) and `docs/CLI.md`
  ([PR210](https://github.com/Zhivex/zhivex-harness/pull/210)). `docs/CLI_UX.md`
  and `docs/images/approval-survives-restart.gif` differ and are outside the
  Harness `files` list.

This preparation adds the `v1.4.0` representative mapping with the same Meta,
Qwen and OpenAI models as `v1.4.0-rc.8` and does not change `src/`. SDK pins
remain the versions already on main: Core 1.31.0, Agents 1.11.0, Anthropic
0.13.2, OpenAI 0.14.1, Qwen 0.16.4, Vertex 1.2.4, Meta 0.2.9 and Gemini 0.13.0.
Provider/API tiers stay unchanged. Stable package numbering does not upgrade
beta or experimental tiers. Desktop stays private alpha.

This is version and documentation preparation only. No paid calls, tag creation,
release dispatch, publication, promotion or merge is authorized. After review and
user integration, require the latest successful `ci.yml`, `codeql.yml`,
`code-journey.yml` and `web.yml` main-push runs for the exact new stable SHA plus
its direct-main CodeQL security result. Use read-only
`bun run release:prepare --sha <full-main-sha>` from that clean frozen main;
do not use `--publish` under preparation approval.

Only a new explicit campaign and publication approval can authorize annotated
`v1.4.0` and the unchanged protected Harness workflow with `channel=latest`.
Its one exact artifact, OCI, live and representative gates remain mandatory.
Independently verify actual Harness registry bytes and source-bound provenance
before the matching Code release. Under separate publication authority, Code uses
annotated `code-v0.3.0` on the same reviewed SHA, `channel=latest`, `mode=oidc`
and explicit confirmation. It must resolve the real published engine without
overrides and pass retained-artifact terminal/web and four-manager acceptance plus
registry/provenance verification. Published rc.8 evidence does not certify 1.4.0
or 0.3.0. The RC.8 preparation snapshot below remains historical.

## Historical RC.8 preparation: 2026-10-08

The source version is `1.4.0-rc.8`, pending publication to `next`.
This checkout prepares Harness `1.4.0-rc.8` and Code `0.3.0-rc.8` for npm
`next`, with Code pinned exactly to the engine and private Desktop bound to the
same Harness version. Both candidates are unpublished. Keep Harness `1.3.0`
and Code `0.2.0` on stable `latest`. Published npm `next` is Harness
`1.4.0-rc.6` and Code `0.3.0-rc.6` from annotated tags at
`0adf4e2e96380864ef4c697ea94df64ad7c18eec`.

RC.8 includes the reviewed duplicate-delegation fix on main after the RC.7 tag,
integrated at `5f43349e928167f4126045fc0f7e38215622fd0b`
([PR198](https://github.com/Zhivex/zhivex-harness/pull/198)). A second
`delegate_*` call for a task already accepted in the same model response stays
non-executable; the next turn tells the coordinator to use the completed result.
A later model step can still recover from an invalid call that did not execute.
Paused runs bound to the previous delegation fingerprint must be completed with
the artifact that created them. Qwen live certification accepts
`DASHSCOPE_API_KEY` alone; `QWEN_API_KEY`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`
and `QWEN_REGION` remain optional overrides. Ordinary no-cap chat, Stable API
signatures, model pins and provider/API tiers stay unchanged. SDK pins remain
the versions already on main: Core 1.31.0, Agents 1.11.0, Anthropic 0.13.2,
OpenAI 0.14.1, Qwen 0.16.4, Vertex 1.2.4, Meta 0.2.9 and Gemini 0.13.0. This
preparation does not bump them. The additive representative mapping uses the
same Meta, Qwen and OpenAI models and preserves every historical row.

Annotated `v1.4.0-rc.7`, tag object
`fb08b8d37e7b95a134336d6c0cdc7efb922561ee`, points at
`1f986a0b044fa2827166fc934c712684971127b5`. Its protected workflow
([run 37819050020](https://github.com/Zhivex/zhivex-harness/actions/runs/37819050020))
passed exact-artifact validation and then failed live certification on Qwen in
the bounded reviewer orchestration gate. Representative evaluation and npm
publication were skipped. No Code `code-v0.3.0-rc.7` tag was created. Do not
rerun, replace or retag that RC.7 artifact as part of this preparation. Its
evidence cannot certify RC.8. Preserve published RC.6, the held RC.5 campaign,
the RC.4 failure, all earlier tags and artifacts, the historical preparation
snapshots below and the RC.4 SDK store migration requirements.

This is version/documentation preparation only. No paid calls, tag creation,
release dispatch, publication, promotion or merge is authorized. After review and
user integration, require the latest successful `ci.yml`, `codeql.yml`,
`code-journey.yml` and `web.yml` main-push runs for the exact new RC.8 SHA plus
its direct-main CodeQL security result. Use read-only
`bun run release:prepare --sha <full-main-sha>` from that clean frozen main;
do not use `--publish` under preparation approval.

Only a new explicit campaign/publication approval can authorize annotated
`v1.4.0-rc.8` and the unchanged protected Harness workflow with `channel=next`.
Its one exact artifact, OCI, live and representative gates remain mandatory.
Independently verify actual Harness registry bytes and source-bound provenance
before the matching Code release. Under separate publication authority, Code uses
annotated `code-v0.3.0-rc.8` on the same reviewed SHA, `channel=next`, `mode=oidc`
and explicit confirmation. It must resolve the real published engine without
overrides and pass retained-artifact terminal/web and four-manager acceptance plus
registry/provenance verification. RC.7's failed campaign does not carry forward;
stable `latest` must remain unchanged.

## Historical RC.7 preparation: 2026-10-08

The source version is `1.4.0-rc.7`, pending publication to `next`.
This checkout prepares Harness `1.4.0-rc.7` and Code `0.3.0-rc.7` for npm
`next`, with Code pinned exactly to the engine and private Desktop bound to the
same Harness version. Both candidates are unpublished. Keep Harness `1.3.0`
and Code `0.2.0` on stable `latest`. Published npm `next` is Harness
`1.4.0-rc.6` and Code `0.3.0-rc.6` from annotated tags at
`0adf4e2e96380864ef4c697ea94df64ad7c18eec`.

RC.7 includes the reviewed commits on main after that tag, integrated at
`40479ead42b7b7db62799766274b95602d0ba80f`: optional Web task/project limits and
immediate composer consumption ([PR189](https://github.com/Zhivex/zhivex-harness/pull/189)),
sanitized Qwen stream diagnostics ([PR188](https://github.com/Zhivex/zhivex-harness/pull/188)),
bounded guided task authority across turns ([PR187](https://github.com/Zhivex/zhivex-harness/pull/187)),
private Desktop Electron 44.5.1 ([PR180](https://github.com/Zhivex/zhivex-harness/pull/180)),
persisted task cancellation ([PR190](https://github.com/Zhivex/zhivex-harness/pull/190), HAR-HU-71)
and task continuity from durable authority ([PR191](https://github.com/Zhivex/zhivex-harness/pull/191), HAR-HU-72).
Ordinary no-cap chat, Stable API signatures, model pins and provider/API tiers stay
unchanged. SDK pins remain the versions already on main: Core 1.31.0, Agents 1.11.0,
Anthropic 0.13.2, OpenAI 0.14.1, Qwen 0.16.4, Vertex 1.2.4, Meta 0.2.9 and Gemini
0.13.0. This preparation does not bump them. The additive representative mapping
uses the same Meta, Qwen and OpenAI models and preserves every historical row.
Logical JSON backups still cannot restore task spending authority. Phase telemetry
and the synthetic offline scaffold do not authorize a paid campaign.

Harness [RC.6](https://github.com/Zhivex/zhivex-harness/actions/runs/37395585612)
completed its protected workflow at annotated `v1.4.0-rc.6`, tag object
`3cfb10c92efce3682ba6015570dcb39094f0c158`. Code `code-v0.3.0-rc.6`, tag object
`aadca63f657b67d5103543f295832745777dbce6`, was accepted by npm in
[run 37399657231](https://github.com/Zhivex/zhivex-harness/actions/runs/37399657231);
that job then failed its immediate registry identity assertion while metadata
still reported the version absent. The registry now serves Code `0.3.0-rc.6` on
`next`. Do not rerun, replace or retag those RC.6 artifacts as part of this
preparation. Their evidence cannot certify RC.7. Preserve the held RC.5 campaign,
the RC.4 failure, all earlier tags and artifacts, the historical preparation
snapshots below and the RC.4 SDK store migration requirements.

This is version/documentation preparation only. No paid calls, tag creation,
release dispatch, publication, promotion or merge is authorized. After review and
user integration, require the latest successful `ci.yml`, `codeql.yml`,
`code-journey.yml` and `web.yml` main-push runs for the exact new RC.7 SHA plus
its direct-main CodeQL security result. Use read-only
`bun run release:prepare --sha <full-main-sha>` from that clean frozen main;
do not use `--publish` under preparation approval.

Only a new explicit campaign/publication approval can authorize annotated
`v1.4.0-rc.7` and the unchanged protected Harness workflow with `channel=next`.
Its one exact artifact, OCI, live and representative gates remain mandatory.
Independently verify actual Harness registry bytes and source-bound provenance
before the matching Code release. Under separate publication authority, Code uses
annotated `code-v0.3.0-rc.7` on the same reviewed SHA, `channel=next`, `mode=oidc`
and explicit confirmation. It must resolve the real published engine without
overrides and pass retained-artifact terminal/web and four-manager acceptance plus
registry/provenance verification. RC.6 publication does not carry forward;
stable `latest` must remain unchanged.

## Historical RC.6 preparation: 2026-10-05

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
tiers are unchanged; see [durable activity](../LOCAL_SERVICE.md). Retain all SDK/model
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


`@zhivex-ai/harness@1.3.0` is the latest public npm release. The verified `v1.3.0` publication and its exact source, registry integrity, SLSA provenance, annotated GitHub tag and release-bound live evidence are recorded in the mutable repository [release-status.json](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json), excluded from immutable npm artifacts. See [LIVE_CERTIFICATION.md](../LIVE_CERTIFICATION.md).

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
See [publication evidence](evidence/stable-publication-2026-10-02.json); historical attempts and the previous
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
unchanged. See the [local campaign](RC2_RECOVERY_REPRESENTATIVE_2026-09-28.json).
