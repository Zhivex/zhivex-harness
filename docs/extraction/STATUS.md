# Electron extraction status

The source baseline is `0bc3927ba57b72ab7c9e18aeef5ab8f6595073a3`. The cutover is implemented and locally verified. Electron source/build/test ownership is now in zhivex-app; Harness retains the motor and CLI unchanged. Existing state and credentials were validated before removal.

## Completed

- Created the private [Zhivex/zhivex-app repository](https://github.com/Zhivex/zhivex-app). [Hosted CI passed](https://github.com/Zhivex/zhivex-app/actions/runs/43928350502) for implementation commit `f959c4177d82e3fd75089a0efd80b3e1358607db`, including artifact production, standalone tests, packaging, recovery, rollback and rejection of unsigned production updates.
- Verified a full Git bundle of all local refs, kept outside the extracted repository. Extracted the main branch ancestry for `desktop/`, `packages/desktop/`, `packages/assistant/` and `LICENSE` in a disposable clone. Historical Assistant paths preserve predecessor UI context; the current tree has no motor or CLI source.
- Verified all 224 baseline Desktop files byte-for-byte and author/committer identities and timestamps for 57 retained commit mappings. Original hashes/signatures remain in Harness and the bundle; the extracted history has new hashes.
- Added public-contract validation for the unified application and an import boundary gate covering source, scripts and tests. Removed core source imports and the legacy source rewrite build plugins.
- Moved engine SQL secret-protection tests into Harness. App recovery fixtures use test-only raw SQLite with the public lock contract; production SQL enforcement stays in Harness. Terminal/catalog assertions remain in Harness; App verifies its engine catalog projection.
- Declared direct dependencies, created an independent lockfile and prepared App CI. The CI producer builds a pinned Harness revision in a separate job; the consumer receives only its artifact.
- Passed Desktop typecheck, import boundary checks, 224 standalone tests (one platform skip), build and macOS arm64 packaging. Harness-side Desktop plus relocated tests passed 229 tests (one platform skip).
- Verified terminal compatibility using a separately packed and installed Code artifact, with an explicit CLI entrypoint and no sibling-source dependency.
- Passed packaged offline Assistant/Code flows, pending reviews, CLI shared context, checkpoints, worktrees, commit/restart recovery, interrupted SQLite restoration, bundled Node/SQLite startup, and temporary application replacement/rollback.
- Harness architecture (including 16 regression tests), documentation and API-contract checks passed. The standalone dependency audit reported no vulnerabilities across 183 packages. The local Harness workspace check found ignored legacy `packages/assistant`, `packages/code` and `packages/web` directories. Those pre-existing local artifacts were preserved; no tracked files exist under those paths. The workspace check passes in a clean tracked-file snapshot with the updated lockfile.

## Cutover verification

- Both packaged executables read the same existing Keychain value. The legacy provider namespace was also checked. Secret values stayed in memory; no credential writes, exports or model requests were performed.
- Both executables opened the real application directory and returned equivalent profile, connection and active-session projections. UI storage was isolated during the rehearsal. A further startup succeeded after the Harness Desktop checkout was removed.
- Fingerprints of all persisted conversation, run and activity tables matched before and after the rehearsal. The original state path, application name, bundle ID and credential namespaces remain unchanged. Private backups and detailed account/profile evidence are not committed.
- The existing migration routine produced a verified backup. Read-only WAL handles stabilized SQLite auxiliary files during its snapshot; no user rows or journal modes were changed. All backup objects were verified and the migration marker was cleared by the tool.
- The retired Desktop checkout and original packaged bundle were archived outside Harness, including the older artifact-only Desktop folder. Core and CLI source trees have no changes.
- Harness now declares only core and CLI workspaces. Its CI, release pipeline, lockfile and current documentation no longer require an Electron checkout. App recovery and UI regressions remain in zhivex-app; Harness retains engine contracts and migration tests.
- Local `bun run check` passed: 2,525 tests, historical migrations, evaluations, benchmarks, MCP and installed-package smoke. The optional local real-OCI smoke skipped because Docker was not running; Linux CI remains configured to require OCI.
- CLI typecheck and all 171 terminal tests passed. App typecheck, import boundaries and 227 tests passed (one platform-specific skip).

Hosted verification of the final cutover is recorded in the pull request. Production signing/notarization and the disabled update feed are separate from this repository change.

## Reproduction and recovery

The local candidate lives at `/Users/mikeortiz/dev/zhivex-app`. The private backup directory is `/Users/mikeortiz/dev/zhivex-app-extraction-backup`; it contains the verified source bundle, exact Harness tarball and execution logs. Do not publish the full source bundle or personal profile copies.

The extraction manifest records file hashes, artifact hashes and test evidence; App additionally keeps the old-to-new commit map. Core changes were unnecessary. The repository name does not change the installed app name, package name, bundle ID, state defaults or Keychain namespaces.

Source rollback is an ordinary revert of the cutover commit; never rewrite shared history. The archived application bundle remains available. Do not restore personal state unless needed: startup lifecycle metadata may advance, while the verified conversations and runs were preserved. See the [original migration procedure](https://github.com/Zhivex/zhivex-harness/blob/0bc3927ba57b72ab7c9e18aeef5ab8f6595073a3/docs/APPLICATION_MIGRATION.md) for a later coordinated installed rehearsal.
