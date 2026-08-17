# Release process

`@zhivex-ai/harness@0.5.0` is configured as a public npm package, but publication is never performed from a development checkout. The confirmation-gated `.github/workflows/release.yml` workflow builds, inspects, transfers, and publishes one exact tarball. Creating a tag alone does not publish anything.

## Deterministic gates

From a clean checkout on `main`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run release:check
git diff --check
git status --short
```

`bun run release:check` performs documentation validation, typechecking, deterministic tests, the golden evaluation gate, a dependency-externalized build, package-content validation, clean tarball installation, direct binary execution, public import, SQLite restart/resume, redacted inspection, exactly-once side-effect verification, dependency audit, untrusted lifecycle-script inspection, dry-run packing, and release metadata validation.

CI repeats the deterministic and installed-package gates on Linux and macOS. Build output is ignored and must not create tracked changes.

## Live gate

Provider behavior is certified separately because it is credential-, account-, model-, endpoint-, and date-dependent:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:orchestration
```

The base reviewed-edit gate and the separate `0.5.x` delegation gate must pass for every provider in the supported release matrix. Integrated provisional providers are reported separately and must not be described as certified. `bun run check` also runs the controlled loopback Streamable HTTP MCP interoperability gate; third-party server claims remain separate. See [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).

## Exact artifact gate

The release workflow performs this sequence across an unprivileged validation job and a protected publication job:

1. check out an existing annotated `v<package-version>` tag with complete history;
2. prove that the tag resolves to `main`, the worktree is clean, and the version is absent from npm;
3. run the complete Bun release gate;
4. create one tarball with `bun pm pack --ignore-scripts`;
5. allow only the documented package roots, verify the packed manifest, and write `SHA512SUMS`;
6. install that same tarball in an isolated consumer and execute its CLI and public API;
7. transfer only the tarball and `SHA512SUMS` into the `npm` environment, then revalidate the checksum and artifact contract;
8. pass that same file to the npm CLI for the registry transaction; and
9. retry through registry propagation, then verify the distribution tag, byte-identical SHA-512 integrity, and SLSA subject/repository/workflow/branch/commit evidence.

For a local artifact rehearsal after the source gate:

```bash
mkdir -p release-artifacts
bun pm pack --filename release-artifacts/zhivex-ai-harness-0.5.0.tgz --ignore-scripts
bun run artifact:check -- release-artifacts/zhivex-ai-harness-0.5.0.tgz
bun run smoke:artifact -- release-artifacts/zhivex-ai-harness-0.5.0.tgz
```

`release-artifacts/`, `.npmrc`, `.env`, source tests, Git metadata, and local run state are excluded from the package.

## External prerequisites

Before the first dispatch:

- make `Zhivex/zhivex-harness` public; npm cannot generate public provenance from a private repository;
- enable GitHub private vulnerability reporting;
- protect the GitHub `npm` environment with required reviewers and restrict it to `main`/release tags;
- verify an npm account with 2FA can create public packages in the `@zhivex-ai` scope; and
- verify `@zhivex-ai/harness` is still unclaimed.

The package does not yet exist on npm, and npm requires a package to exist before Trusted Publishing can be configured. For `0.5.0` only, create a temporary granular npm token with the minimum available organization scope, store it as `NPM_TOKEN` in the protected `npm` environment, and remove it immediately after the first successful publication. The workflow still publishes from GitHub Actions with `--provenance`.

After `0.5.0` exists:

1. configure its npm Trusted Publisher as organization `Zhivex`, repository `zhivex-harness`, workflow `release.yml`, environment `npm`, allowed action `npm publish`;
2. set package publishing access to require 2FA and disallow tokens;
3. delete the GitHub `NPM_TOKEN` secret and revoke the temporary token; and
4. use OIDC-only workflow publication for every later version.

Trusted Publishing currently requires npm CLI `11.5.1` or newer and Node `22.14.0` or newer. The workflow follows npm's current Node 24 guidance and uses npm only for the OIDC/provenance-aware registry transaction; dependency management, build, tests, packing, and artifact installation remain Bun-first.

## Tag and dispatch

After the release commit is reviewed, merged, and pushed to `main`:

```bash
git tag -a v0.5.0 -m "Release v0.5.0"
git push origin v0.5.0
gh workflow run release.yml \
  -f tag=v0.5.0 \
  -f channel=latest \
  -f confirm_publication=true
```

The boolean confirmation is intentional because npm versions are immutable. The `npm` environment should add a second human approval boundary. Do not use `bun publish`, a local npm session, or a manual registry upload as an alternate path.

If npm accepted the immutable version but the post-publication verifier failed during propagation, rerun only the failed `publish` job. It downloads the already validated artifact, skips `npm publish` only when the registry version has byte-identical integrity, and repeats the registry/provenance verification. Never rebuild, bump, or republish the same version to recover a post-publication false negative.

## Publication stop conditions

Do not dispatch or approve publication when any of these is true:

- the repository is not public, the tag is not annotated, the tagged commit is not on `main`, or the worktree used to create it was dirty;
- deterministic, installed-artifact, required live-provider, or release-artifact evidence failed;
- package scope ownership, 2FA, the intended `public` access level, or the protected environment is unclear;
- the inspected package contents and the to-be-published artifact are not the same file;
- the package version already exists in npm;
- the temporary first-release credential is broader or longer-lived than necessary;
- Trusted Publishing is expected but its repository, workflow filename, environment, or allowed action disagrees with the workflow; or
- version, changelog, tag, registry metadata, source commit, integrity, or provenance disagree.

Current npm requirements should be revalidated against the official [Trusted Publishing guide](https://docs.npmjs.com/trusted-publishers/), [provenance guide](https://docs.npmjs.com/generating-provenance-statements/), and [Bun packaging documentation](https://bun.com/docs/pm/cli/publish) before any registry mutation.
