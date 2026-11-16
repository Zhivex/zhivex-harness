# Electron extraction status

The source baseline is `0bc3927ba57b72ab7c9e18aeef5ab8f6595073a3`. Extraction is in progress; Desktop has not been removed from Harness and no existing application/profile/credential was replaced.

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

## Remaining before cutover

1. Inventory the effective existing Electron profile and all external Code state roots with the installation stopped for a coordinated rehearsal. The default identities have been preserved, but no real user database was opened or migrated during extraction.
2. Verify the actual existing Keychain service/account access with the replacement executable identity. Offline memory secrets do not establish this; no credentials were read, exported, re-entered or deleted. Production signing/notarization and the update feed remain unconfigured.
3. Only then remove Desktop from the current Harness tree in an ordinary commit, update Harness CI/workspaces/docs and run core/CLI and cross-client acceptance. Keep history and prior artifacts for recovery.

## Reproduction and recovery

The local candidate lives at `/Users/mikeortiz/dev/zhivex-app`. The private backup directory is `/Users/mikeortiz/dev/zhivex-app-extraction-backup`; it contains the verified source bundle, exact Harness tarball and execution logs. Do not publish the full source bundle or personal profile copies.

The extraction manifest records file hashes, artifact hashes and test evidence; App additionally keeps the old-to-new commit map. Core changes were unnecessary. The repository name does not change the installed app name, package name, bundle ID, state defaults or Keychain namespaces.

Rollback before cutover means keeping Harness authoritative and discarding or repairing the extracted candidate. No personal-state rollback is needed because extraction has not modified it. See the [original migration procedure](https://github.com/Zhivex/zhivex-harness/blob/0bc3927ba57b72ab7c9e18aeef5ab8f6595073a3/docs/APPLICATION_MIGRATION.md) for a later coordinated installed rehearsal.
