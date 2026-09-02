# Release process

`@zhivex-ai/harness@0.11.1` is the latest public npm release and `v0.11.1` its annotated tag. Its exact source, registry integrity, SLSA provenance, GitHub Release, and release-bound live-certification evidence are tracked in the mutable repository [release-status.json](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json), which is intentionally excluded from immutable npm artifacts. Publication is never performed from a development checkout. The confirmation-gated `.github/workflows/release.yml` workflow builds, inspects, certifies, transfers, and publishes one exact tag-bound tarball through npm Trusted Publishing/OIDC. Creating a tag alone does not publish anything, and publication does not retroactively substitute for a missing live-provider gate.

## Deterministic gates

From a clean checkout on `main`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run release:check
git diff --check
git status --short
```

`bun run release:check` performs documentation validation, typechecking, deterministic tests, the golden evaluation gate, the required real-OCI boundary gate, a dependency-externalized build, package-content validation, clean tarball installation, direct binary execution, public import, SDK execution-environment import, SQLite restart/resume, redacted inspection, exactly-once side-effect verification, dependency audit, untrusted lifecycle-script inspection, dry-run packing, and release metadata validation.

CI repeats the deterministic and installed-package gates on Linux and macOS. Build output is ignored and must not create tracked changes.

## Live gate

Provider behavior is certified separately because it is credential-, account-, model-, endpoint-, and date-dependent:

```bash
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
7. run the protected base, orchestration, routing, and model-directed OCI live gates from the same annotated tag and source commit;
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

`release-artifacts/`, `.npmrc`, `.env`, source tests, Git metadata, and local run state are excluded from the package.

## External prerequisites

Before a release dispatch, reverify repository/package visibility compatibility, protected-environment reviewers, package ownership with 2FA, and that the Trusted Publisher identity matches the repository workflow. Do not rely on a previous release's state.

The release workflow intentionally supplies no long-lived registry token. Do not introduce one as a fallback; a failed OIDC assertion is a stop condition to diagnose.

Trusted Publishing currently requires npm CLI `11.5.1` or newer and Node `22.14.0` or newer. The workflow follows npm's current Node 24 guidance and uses npm only for the OIDC/provenance-aware registry transaction. Dependency management, tests, and packing use Bun as contributor tooling; the built CLI, public library, SQLite reopen, and installed artifact execute under Node.

## Tag and dispatch

After review and merge, maintainers create an annotated `v<package.json version>` tag from the exact release commit and dispatch the protected workflow with that tag plus an explicit publication confirmation. The workflow YAML contains no release-version default: `package.json` is the source of version truth, and the required tag input is validated against it before publication. The canonical dispatch is bound to `main`; recovery is limited to the exact annotated version tag after proving it resolves to the expected commit and remains reachable from `origin/main`.

The confirmation is intentional because registry versions are immutable, and the protected environment adds a second human approval boundary. Do not use a local registry session or manual upload as an alternate path.

Release candidates use versions and annotated tags such as `1.0.0-rc.1` / `v1.0.0-rc.1` and must publish to `next`. Stable versions must publish to `latest`; the readiness gate rejects either channel mismatch before registry mutation. The representative assembly matrix explicitly authorizes RC.1 through RC.12 and the final `v1.0.0` tag and pins the Meta, Qwen, and OpenAI model for each, so both candidate and stable publication execute the exact unpacked tarball runtime rather than a checkout-only build. Failed immutable attempts remain in the readiness ledger but do not count toward GA. Before any `1.0.0` dispatch, `bun run readiness:1.0:release` must pass. That gate requires two complete passing RC records, current security and representative evaluation evidence, historical migration fixtures, and no open GA blocker. Every representative provider runs even after another fails; one final aggregate gate blocks publication. Every live/OCI phase, including image preload, also runs through its own fail-closed diagnostic wrapper before the aggregate decision. Failed jobs upload only bounded, strict-schema outcomes self-bound to the release tag, source commit, canonical tarball SHA-512, workflow run, and `github.run_attempt`; representative diagnostics additionally bind provider/model, driver commit, and OCI image digest. Cross-provider identity drift, a missing binding, or an incoherent passed/failed state is treated as unavailable evidence. Raw child stdout/stderr is not relayed, and raw prompts, provider output, error messages, response bodies, headers, credentials, run identifiers, and stacks remain excluded. See [GA_READINESS.md](./GA_READINESS.md), [ROLLBACK.md](./ROLLBACK.md), and [DEPRECATIONS.md](./DEPRECATIONS.md).

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
