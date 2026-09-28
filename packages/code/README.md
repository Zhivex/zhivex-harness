# Zhivex Code

The terminal product for the Zhivex Harness engine. Version `0.1.0-rc.1` is
prepared for the npm `next` channel and pins `@zhivex-ai/harness@1.3.0-rc.3`.
Publication remains pending the protected release workflow and registry checks.

After publication, install with `npm install -g @zhivex-ai/code@next`.
Node >=22.13.0 is required; consumers do not need Bun.

## Build and run

Install a compatible Harness package and the declared dependencies, then run
`bun run build`, `bun run typecheck`, and `bun test tests` from this directory.
The build reads only Code source and leaves all package dependencies external.
For this pre-release monorepo checkout, run `bun run build` at the repository root,
then `bun run packages/code/scripts/link-local-engine.ts`. This explicit contributor
command links the built root package into Code's ignored `node_modules`, validates
its public export artifacts and preserves any installed dependency. It does not run
as an install/build lifecycle script and does not read or bundle engine source.
The root manifest is now `1.3.0-rc.3`; this link is local API development
evidence only. Installed acceptance tests the exact unpublished Harness RC tarball
without rewriting its version, which matches Code's exact engine pin.

The resulting tarball runs on Node >=22.13.0 without Bun, TypeScript, or install
scripts. Bun is contribution tooling only. The independent build deliberately
does not reach into the monorepo's Harness source or bundle its engine.

```sh
zhivex-code --help
zhivex-code init
zhivex-code run --json "Explain this repository"
zhivex-code doctor
```

Code owns only the `zhivex-code` executable. Harness 1.x retains `zhx`,
`zhivex-harness`, and `zhx-acp`. Installing either product does not claim the
other's binary names. Code has no public library API.

## Compatibility

The terminal sources were extracted from the Harness 1.x CLI. Commands, flags,
exit codes, approval behavior, JSON schemas, profiles, state directory defaults,
and keychain identifiers remain compatible. Product help and the welcome screen
identify Code; `--version` identifies Code's version. The doctor JSON field
`harnessVersion` still identifies the actual engine dependency. Provider selection,
interactive prompts, keychain access and terminal rendering live in Code.

The engine owns shared CLI option contracts, JSON/event serialization, run result
projection and continuation reconstruction. Code consumes named Harness exports;
experimental `/code-support` supplies bounded host helpers. The diagnostic SQLite
helper returns a read-only projection, never a connection or arbitrary SQL API.
The historical Harness CLI remains an independent compatibility snapshot.

## Release status

Packing and local tests are not a registry release. The independent Code workflow
validates an annotated `code-v0.1.0-rc.1` tag on reviewed main, its exact CI/CodeQL
results, and the published engine dependency. It tests one immutable Code tarball
both without dependency overrides and with the four package managers.

The first publication uses the retained validated tarball and its GitHub-generated
npm provenance bundle with an authenticated scope owner. Later publications use
npm Trusted Publishing with the protected `npm` environment. See
[Code release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/CODE_RELEASE.md) in the source repository.
HAR-HU-40 remains responsible for broader compatibility and install-order coverage;
this initial RC pins one engine version and does not claim the complete matrix.
