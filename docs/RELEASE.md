# Release process

This repository prepares and certifies release artifacts but does not publish automatically. Publication is a separate irreversible operation.

## Deterministic gates

From a clean checkout on `main`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun audit
bun run check
bun run pack:inspect
git diff --check
git status --short
```

`bun run check` performs typechecking, deterministic tests, a dependency-externalized build, package-content validation, clean tarball installation, direct binary execution, public import, mock run, approval persistence, process-style store restart, and exactly-once side-effect verification.

CI repeats the deterministic and installed-package gates on Linux and macOS. Build output is ignored and must not create tracked changes.

## Live gate

Provider behavior is certified separately because it is credential-, account-, model-, endpoint-, and date-dependent:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
```

The gate must pass for every provider in the supported release matrix. Integrated provisional providers are reported separately and must not be described as certified. See [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).

## Package inspection

`bun run pack:inspect` must include only the intended runtime files, documentation, manifest, license, and changelog. It must exclude `.env`, source tests, Git metadata, local run state, and workspace build inputs.

The package is configured as public under the `@zhivex-ai` scope. The registry had no existing `@zhivex-ai/harness` package when `0.2.0` was prepared, so scope permission and first-package creation remain external release prerequisites.

## Publication stop conditions

Do not publish when any of these is true:

- the branch is not `main` or the worktree is dirty;
- deterministic, installed-artifact, or required live evidence failed;
- package scope ownership or the intended access level is unclear;
- the inspected package contents and the to-be-published artifact are not demonstrably identical;
- the GitHub repository remains private while public npm provenance is being claimed;
- trusted publishing or the publication credential boundary has not been configured and tested;
- version, changelog, tag, registry metadata, or source commit disagree.

The repository is currently private, so `0.2.0` must not claim public npm provenance until the repository visibility and trusted-publisher flow support that evidence. The release may be code-complete while publication remains blocked by this external decision. Revalidate the current requirements against the official [npm provenance guide](https://docs.npmjs.com/generating-provenance-statements/) and [Bun publish documentation](https://bun.com/docs/pm/cli/publish) before the first registry mutation.
