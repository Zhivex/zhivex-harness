# Release process

This repository prepares and certifies release artifacts but does not publish automatically. The active `0.3.x` milestone is explicitly private (`private: true`, without `publishConfig`); packing is retained only to verify installability. Publication is a separate irreversible operation that remains disabled until a later visibility decision.

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

The tagged `0.2.0` baseline was prepared with public-package metadata, but it was not published. The active `0.3.x` manifest intentionally prevents registry publication. The registry had no existing `@zhivex-ai/harness` package when `0.2.0` was prepared, so scope permission, visibility, provenance, and first-package creation remain deferred external prerequisites.

## Publication stop conditions

Do not publish when any of these is true:

- the branch is not `main` or the worktree is dirty;
- deterministic, installed-artifact, or required live evidence failed;
- package scope ownership or the intended access level is unclear;
- the inspected package contents and the to-be-published artifact are not demonstrably identical;
- the GitHub repository remains private while public npm provenance is being claimed;
- trusted publishing or the publication credential boundary has not been configured and tested;
- version, changelog, tag, registry metadata, or source commit disagree.

The repository is currently private and `0.3.x` is a development milestone, so it must not claim public npm provenance or be published. Revalidate the current requirements against the official [npm provenance guide](https://docs.npmjs.com/generating-provenance-statements/) and [Bun publish documentation](https://bun.com/docs/pm/cli/publish) before any future registry mutation.
