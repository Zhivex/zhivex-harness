# Zhivex Code

The terminal product for the Zhivex Harness engine. This checkout prepares
`0.2.0`, pinned to `@zhivex-ai/harness@1.3.0`; publication is pending. Version `0.1.0` is
published and verified on npm `latest` and pins `@zhivex-ai/harness@1.3.0`.
The protected workflow verified registry bytes, source-bound provenance and
actual engine dependency resolution.

Install with `npm install -g @zhivex-ai/code@0.1.0`.
Node >=22.13.0 is required; consumers do not need Bun.

The equivalent global installation commands are `pnpm add -g @zhivex-ai/code@0.1.0`,
`yarn global add @zhivex-ai/code@0.1.0` (Yarn Classic), and
`bun add -g @zhivex-ai/code@0.1.0`. Choose the project's existing manager for local
installation: `npm install`, `pnpm add`, `yarn add`, or `bun add`, followed by
`@zhivex-ai/code@0.1.0`. Harness keeps `zhx` and `zhivex-harness`; Code owns
`zhivex-code`, so installing both does not replace those aliases.

The local candidate matrix covers npm, pnpm 11, Yarn Classic 1 and Bun 1.4 on
Node 22.13 and 24.11. It uses exact tarballs and a temporary registry where needed;
these results do not establish that the stable versions are available from `latest`.
See [engine acceptance](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ENGINE_API.md) for reproducible commands and
the distinction between installed acceptance and publication/provenance.

## Build and run

Install a compatible Harness package and the declared dependencies, then run
`bun run build`, `bun run typecheck`, and `bun test tests` from this directory.
The build reads only Code source and leaves all package dependencies external.
For this stable monorepo checkout, run `bun run build` at the repository root,
then `bun run packages/code/scripts/link-local-engine.ts`. This explicit contributor
command links the built root package into Code's ignored `node_modules`, validates
its public export artifacts and preserves any installed dependency. It does not run
as an install/build lifecycle script and does not read or bundle engine source.
The root manifest is now `1.3.0`; this link is local API development
evidence only. Installed acceptance must test the exact Harness version pinned by
Code, without rewriting its version.

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

Anthropic is available through the engine provider registry and shared model catalog.
Configure `ANTHROPIC_API_KEY`, or use `/credentials` for a system keychain or
temporary key. Managed keys require the default Anthropic endpoint. Vertex uses
host Application Default Credentials with `GOOGLE_CLOUD_PROJECT` and
`VERTEX_LOCATION`; Code does not ask for or store a Vertex API key.

## Release status

Packing and local tests are not a registry release. The independent Code workflow
validates an annotated `code-v0.2.0` tag on reviewed main, its exact CI/CodeQL
and installed-journey results, and the published engine dependency. It tests one immutable Code tarball
both without dependency overrides and with the four package managers.

The prepared stable 0.2.0 uses the existing npm Trusted Publishing configuration and protected
`npm` environment. Historical first-publication bootstrap is documented separately. See
[Code release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/CODE_RELEASE.md) in the source repository.
Code 0.1.0 is published and verified on latest; RC2 remains on next and RC1 is
historical. Stable acceptance used the published Harness 1.3.0 dependency. The local
four-manager matrix covers both install orders; it does not certify other engine
versions, upstream provider parity or registry provenance. Beta/experimental
engine helpers and provisional Anthropic/Gemini/Vertex routes retain their tiers.

## Guided runs in the 0.2.0 candidate

The 0.2.0 candidate adds console workflows on published Harness 1.3.0 APIs.
Use the candidate tarball to try these features before publication. See the
[Code changelog](CHANGELOG.md) for migration notes.

Approvals for local reviewed edits, patches and replacements show a per-file
changed-region diff from the engine's digest-validated preview. The complete
approval payload remains available. Unavailable or oversized previews are labeled
explicitly; the engine still rechecks preconditions when applying changes.

Use `/checkpoint` to capture, list, review or restore files. Capture requires a
terminal conversation turn and explicitly selected existing UTF-8 text files:
1–20 files, at most 64 KiB each. For example:

```text
/checkpoint capture ["src/greeting.mjs", "src/greeting.test.mjs"]
/checkpoint list
/checkpoint review
/checkpoint restore
```

Restore displays current contents, captured contents and current digests. Typing
`prepare` explicitly adopts those displayed preconditions. A second review shows
the exact prepared proposal; typing `restore` applies it and switches to a fork
of the captured conversation. Original conversations remain intact. Leaving the
second prompt empty retains the operation; `/checkpoint retry` reviews its original
digests again. Conflicts, missing files and partial operations fail closed. The UI
never silently refreshes digests, narrows the file set or rolls back files. Uncertain
conversation forks require manual engine recovery. Creation, deletion, binary files
and mode changes are outside checkpoint coverage. The engine bounds storage to 100
records per scope, 2 MiB per record, without automatic eviction; reviewed retention
remains an engine API operation.

Model selection displays advisory USD prices where the shared catalog supplies
them; `/pricing` shows their scope, checked date and source. Missing prices say
`unknown`. These prices do not automatically configure a monetary policy.
Use `/budget` or `/budget 1` to review an operator pricing JSON file and configure
an estimated USD limit for each new run. `/budget off` disables that monetary
limit. Existing `--pricing-file` and `--usage-limit-usd` flags work for automation.
See the offline fixture's `prices.json` for the schema; its rates are synthetic
and must not be used as real provider prices.

Usage appears after model steps and in `/usage`. A pending run retains its original
ledger policy across approval resumption and restart. A new turn, `/continue`, or
review group receives a new run budget; there is no session-wide financial cap.
The engine reserves estimated requests with an output cap of up to 2048 tokens
and blocks insufficient estimated budget, missing/stale prices and uncertain usage.
Actual tokenization, provider billing, cached tokens and pricing tiers can differ.
Estimates are not invoices or guaranteed financial caps. Other step, token, tool
and time limits continue to apply.

## First use with Node and an offline fixture

The 0.2.0 candidate tarball includes a tutorial that needs Node >=22.13.0 and npm.
It does not need Bun, Python, Git, credentials or a paid provider. In an empty
directory, install the candidate tarball from this PR (or pack a contributor build):

```sh
npm install --ignore-scripts /absolute/path/to/zhivex-ai-code-0.2.0.tgz
node node_modules/@zhivex-ai/code/examples/first-use.mjs
```

The launcher creates a temporary workspace and prints a guided sequence: inspect,
capture a checkpoint, set a per-run budget, request a fix, review/approve its diff,
review/approve a Node test, inspect usage, interrupt with Ctrl+C, exit/reopen and
`/continue`. Finally, review and restore the checkpoint. It prints a command to
reopen the same workspace and never overwrites existing fixture files. The preload
replaces fetch entirely, rejecting unexpected endpoints; all responses, token counts
and rates are synthetic. The actual Code console, engine persistence, approvals,
file edits and Node check commands still run. Removing the temporary workspace is
the user's explicit cleanup step.

Contributors run `bun run build`, `bun run typecheck`, `bun run test`, then
`bun run smoke:installed` in this package. The installed acceptance driver packs
Code, installs it with npm and the exact published Harness 1.3.0 dependency (no
override or source link), then exercises the tutorial in a Linux/macOS PTY. Python
3 is test tooling only. Set `CODE_JOURNEY_OUTPUT` to retain its report and transcript.

To test an already retained artifact without repacking, run
`node scripts/installed-journey.mjs /absolute/path/to/code.tgz`. The report binds
the source SHA, Node version, tarball size and SHA-512 to the offline PTY result.
Release validation uses this mode on the same bytes that will be published.
