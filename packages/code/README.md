# Zhivex Code

The terminal product for the Zhivex Harness engine. This is an unpublished development
package (`0.1.0-dev.0`), with publication disabled while the first release is reviewed.
It requires the new public APIs planned for Harness 1.3.0; registry Harness 1.2.0
cannot satisfy this implementation. `>=1.3.0-0 <2.0.0` allows staging the additive
candidate locally without misrepresenting the existing registry package.

## Build and run

Install a compatible Harness package and the declared dependencies, then run
`bun run build`, `bun run typecheck`, and `bun test tests` from this directory.
The build reads only Code source and leaves all package dependencies external.
For this pre-release monorepo checkout, run `bun run build` at the repository root,
then `bun run packages/code/scripts/link-local-engine.ts`. This explicit contributor
command links the built root package into Code's ignored `node_modules`, validates
its public export artifacts and preserves any installed dependency. It does not run
as an install/build lifecycle script and does not read or bundle engine source.
The root manifest is now `1.3.0-rc.1`; this link is local API development
evidence only. Installed acceptance tests the exact unpublished Harness RC tarball
without rewriting its version, which satisfies Code's declared release range.

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

Packing and installed local candidate tests are not a registry release. The scoped
name and publication permissions need an authenticated scope-owner check; the
2026-09-28 HAR-HU-36 check returned E404 for package visibility and E401 for identity
and organization access. No successful reservation or write permission is inferred.
Minimum/latest engine versions and package-manager/install-order certification
belong to HAR-HU-40. Remove `private` only as part of an authorized release after
those gates and the additive Harness release are ready.
