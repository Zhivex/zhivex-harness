# Release process

`@zhivex-ai/harness@0.9.0` is the latest public npm release. `0.10.0` is a Node-first source candidate, not a published artifact. Publication is never performed from a development checkout. The confirmation-gated `.github/workflows/release.yml` workflow builds, inspects, transfers, and publishes one exact tarball through npm Trusted Publishing/OIDC. Creating a tag alone does not publish anything.

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
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:execution
ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run smoke:oci
```

The base reviewed-edit gate and the separate delegation gate must pass for every provider in the supported release matrix. The workflow must additionally pass the real OCI boundary before live model execution; model-directed environment use is recorded separately from deterministic container enforcement. Gemini remains provisional until its three provider gates and a mixed-provider route pass. Integrated provisional providers are reported separately and must not be described as certified. `bun run check` also runs controlled Streamable HTTP MCP interoperability gates; each external implementation claim remains bounded to the tested server/version. See [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).

## Exact artifact gate

The release workflow performs this sequence across an unprivileged validation job and a protected publication job:

1. check out an existing annotated `v<package-version>` tag with complete history;
2. prove that the tag resolves to `main`, the worktree is clean, and the version is absent from npm;
3. run the complete release gate with Bun-managed contributor tooling and the supported Node runtime;
4. create one tarball with `bun pm pack --ignore-scripts`;
5. allow only the documented package roots, verify the packed manifest, and write `SHA512SUMS`;
6. install that same tarball in an isolated consumer and execute its CLI and public API;
7. transfer only the tarball and `SHA512SUMS` into the `npm` environment, then revalidate the checksum and artifact contract;
8. pass that same file to the npm CLI for the registry transaction; and
9. retry within one absolute five-minute deadline through registry and attestation propagation, capping every request and sleep by the remaining time, then verify the distribution tag, byte-identical SHA-512 integrity, and SLSA subject/repository/workflow/ref/commit evidence. The ref must be `main` or the exact `v<package-version>` tag; arbitrary branches and tags fail closed.

For a local artifact rehearsal after the source gate:

```bash
mkdir -p release-artifacts
bun pm pack --filename release-artifacts/zhivex-ai-harness-0.10.0.tgz --ignore-scripts
bun run artifact:check -- release-artifacts/zhivex-ai-harness-0.10.0.tgz
bun run smoke:artifact -- release-artifacts/zhivex-ai-harness-0.10.0.tgz
```

`release-artifacts/`, `.npmrc`, `.env`, source tests, Git metadata, and local run state are excluded from the package.

## External prerequisites

Before a release dispatch, reverify repository/package visibility compatibility, protected-environment reviewers, package ownership with 2FA, and that the Trusted Publisher identity matches the repository workflow. Do not rely on a previous release's state.

The release workflow intentionally supplies no long-lived registry token. Do not introduce one as a fallback; a failed OIDC assertion is a stop condition to diagnose.

Trusted Publishing currently requires npm CLI `11.5.1` or newer and Node `22.14.0` or newer. The workflow follows npm's current Node 24 guidance and uses npm only for the OIDC/provenance-aware registry transaction. Dependency management, tests, and packing use Bun as contributor tooling; the built CLI, public library, SQLite reopen, and installed artifact execute under Node.

## Tag and dispatch

After review and merge, maintainers create an annotated version tag from the exact release commit and dispatch the protected workflow with an explicit publication confirmation. The canonical dispatch is bound to `main`; recovery is limited to the exact annotated version tag after proving it resolves to the expected commit and remains reachable from `origin/main`.

The confirmation is intentional because registry versions are immutable, and the protected environment adds a second human approval boundary. Do not use a local registry session or manual upload as an alternate path.

If npm accepted the immutable version but the post-publication verifier failed during propagation, rerun only the failed `publish` job. It downloads the already validated artifact, skips `npm publish` only when the registry version has byte-identical integrity, and repeats the registry/provenance verification. Never rebuild, bump, or republish the same version to recover a post-publication false negative.

## Publication stop conditions

Do not dispatch or approve publication when any of these is true:

- the repository is not public, the tag is not annotated, the tagged commit is not on `main`, or the worktree used to create it was dirty;
- deterministic, installed-artifact, required live-provider, or release-artifact evidence failed;
- package scope ownership, 2FA, the intended `public` access level, or the protected environment is unclear;
- the inspected package contents and the to-be-published artifact are not the same file;
- the package version already exists in npm;
- an npm token or `NODE_AUTH_TOKEN` has been reintroduced into the OIDC-only workflow;
- Trusted Publishing is expected but its repository, workflow filename, environment, or allowed action disagrees with the workflow; or
- version, changelog, tag, registry metadata, source commit, integrity, or provenance disagree.

Current npm requirements should be revalidated against the official [Trusted Publishing guide](https://docs.npmjs.com/trusted-publishers/), [provenance guide](https://docs.npmjs.com/generating-provenance-statements/), and [Bun packaging documentation](https://bun.com/docs/pm/cli/publish) before any registry mutation.
