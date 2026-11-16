# Extract Electron into zhivex-app

Status: implementation started. The private zhivex-app repository has been created, and standalone local and hosted CI passed; installed credential continuity and Harness cutover remain pending. See [execution status](extraction/STATUS.md).

Baseline inspected: `zhivex-harness` commit `0bc3927ba57b72ab7c9e18aeef5ab8f6595073a3` (2026-11-16). Recheck the source revision and working tree before implementation.

## Outcome and scope

Create `Zhivex/zhivex-app` as the independent Electron product repository. Keep the runtime, shared application domain, Assistant integrations, and terminal CLI in `zhivex-harness`. The app consumes a versioned Harness artifact; it never carries a fork of the motor. Initially retain `packages/desktop` inside the new repository to reduce path churn and leave room for a future commercial backend.

The extraction must preserve source history, local conversations and project state, pending decisions, credential references, and CLI/Desktop interoperability. Account login, billing, cloud sync, rebranding of installed binaries, schema changes, and production signing are separate follow-up work. Recommend a private destination initially; confirm repository visibility and ownership when executing the creation step. Existing source license and attribution notices must be retained.

## Observed starting point

- The root package publishes `@zhivex-ai/harness` 1.7.0 from `packages/core/src`. Core remains private as a workspace; do not change package identity or existing exports/binaries.
- `packages/cli` owns the independently built terminal product and remains here.
- Desktop has its own version (`0.1.0-alpha.1`), build and packaging scripts. `prepare-harness.ts` installs an existing tarball and checks the exact Harness version; build/package record and compare artifact hashes.
- The separation is incomplete in tooling: Desktop tests such as `update-inventory.test.ts` and scripts such as `sqlite-access-runtime.ts` and `state-transaction-runtime.ts` import `packages/core/src`. Smoke scripts assume a monorepo root and some exercise the CLI from that checkout.
- Root CI, dependency audit, SQLite test preload, TypeScript dependencies, documentation checks, architecture checks, workspace assertions and the shared `bun.lock` need explicit ownership changes.
- Packaging currently uses `Zhivex Harness` and bundle ID `ai.zhivex.harness`. The package name is `zhivex-harness-desktop`.
- Unified main defaults application state to `~/.zhx-app`; Electron profile state comes from `app.getPath("userData")`, with a test override. External Code state and project/worktree paths also matter.
- The unified credential worker uses service `ai.zhivex.assistant`; the native helper uses `ai.zhivex.harness.providers`. Accounts and stored references must be inventoried without reading or exporting secret values.
- Distribution is not yet certified for production. Repository extraction must not enable the update feed or imply signing/notarization certification.

## Ownership after extraction

| Area | Owner |
| --- | --- |
| Engine, tools, approvals, persistence, state migrations, shared application/coordinator domain | Harness |
| CLI source, release pipeline and compatibility binaries | Harness |
| Electron main/preload/renderer, native helpers, assets, packaging, updater UI and app release pipeline | App |
| Protocol and reusable public contracts consumed by both clients | Harness; App consumes the artifact |
| Engine-internal persistence/locking tests and fixtures | Harness |
| Electron UI, bridge, lifecycle, update integration and packaged acceptance tests | App |
| Historical reports already in Harness | Retain in Harness; link by immutable source revision |
| New app-specific guides and future account/backend integration | App |

Do not move `packages/core/src/application` into App just because Electron calls it: CLI shares that domain. Do not expose internal SQL constructors merely to make Desktop tests compile.

## Phase 1 — Inventory and freeze the compatibility baseline

Deliver a migration manifest with the exact source commit, Desktop and Harness versions, supported platform, imported exports, scripts/fixtures to move, historical source paths, app identity, data locations and non-secret credential identifiers.

1. Inspect tracked changes and active work; agree on one cutover revision and avoid concurrent Desktop edits during the final extraction window.
2. Trace historical paths and renames through all relevant refs, including earlier Desktop/UI locations. A filter containing only today's `packages/desktop` is insufficient if earlier code lived elsewhere. Identify mixed commits and shared files explicitly.
3. Save a full Git bundle of the selected source refs, verify it, and retain it outside any disposable extraction clone. Record source tree hashes for moved files. Keep the original Harness history unchanged.
4. Capture a reproducible baseline using the exact current core tarball, Desktop package and CLI artifact. Record SHA-256 values and existing verification results, without treating old results as new verification.
5. Inventory actual packaged and development profile paths, socket/lock ownership, external project state and Keychain service/account references. Do not infer the effective Electron profile from the bundle ID alone.

Exit gate: reviewed inventory covers history, build dependencies, persistent identities and recovery artifacts.

## Phase 2 — Make Desktop an independent artifact consumer

Complete this while the code is still in Harness so behavior can be compared directly.

1. Remove source-relative core imports from app scripts/tests. Move true engine-internal tests into Harness; rewrite app integration tests against public contracts and installed package fixtures. Add a narrow public contract only when the app actually needs that capability.
2. Inventory every Harness subpath imported by the unified app and tools. Extend candidate validation beyond the older engine/protocol/service list to include the required application and Assistant surfaces.
3. Make script paths relative to the app workspace or explicit fixture/artifact arguments. Cross-client tests must consume a built CLI artifact, not sibling source directories.
4. Declare all direct build/test dependencies in App, including TypeScript and Node/Bun types currently supplied by the root. Give the new repository its own root manifest, immutable lockfile and test configuration.
5. Port the dependency audit, necessary test setup, browser/host import boundary checks and documentation validation. Keep the production update gate disabled.
6. Build and run the app in an isolated consumer checkout containing no Harness source and no usable sibling checkout. Install dependencies with a frozen lockfile; prepare an exact core tarball; run typecheck, app tests, build, package and packaged smoke.

Exit gate: App works solely from its checkout, declared dependencies and explicit versioned Harness/CLI artifacts. No hidden monorepo imports or root-path dependencies remain.

## Phase 3 — Extract history in a disposable clone

Use a fresh clone and a history-filtering tool such as `git filter-repo`; never rewrite the working Harness repository or force-push its existing refs.

1. Construct an explicit inclusion manifest from Phase 1: current and historical app source paths, native code, tests, assets and app-owned documentation. Retain historical locations initially if path rewrites would collide; normalize the current tree in a subsequent ordinary commit.
2. Include required license/attribution material. Shared current tooling/configuration can be adapted in a follow-up commit with an origin manifest linking the original commit and path.
3. Preserve author, committer, timestamps and messages where filtering permits. Filtering changes commit IDs; retain the generated old-to-new commit map. Original commit IDs, signatures and complete mixed-commit context remain in the source repository and verified bundle. Filtered commits must not be presented as retaining valid original signatures.
4. Verify repository integrity, compare extracted file bytes with the source manifest, and sample blame/log history across pre-move and post-move revisions. Check branch/tag inclusion deliberately; do not publish unrelated Harness release tags as App releases.
5. Add new repository metadata, README, workflows and independent dependency lockfile in ordinary commits. Keep installed identity and runtime state defaults unchanged.
6. Create and populate the destination after validation, with an initial extraction release/tag and immutable provenance record. Configure repository settings and CI permissions explicitly; issues, PR discussions, release assets and secrets do not migrate with Git history. Keep links to the original discussions, and recreate only required CI credentials through the hosting platform.

Exit gate: App history and provenance are inspectable, its current tree matches the approved baseline plus documented tooling changes, and standalone CI passes.

## Phase 4 — Prove state and credential continuity

A repository move must require no user-data conversion. For the first extracted app keep the package name, displayed binary name, bundle ID, effective Electron profile path, state directories, credential service/account names, native helper identity and coordinator transport conventions unchanged. The repository can be named `zhivex-app` without renaming those persisted identities.

Use disposable state for automated tests. For an installed upgrade rehearsal, close Electron, CLI and every coordinator sharing the state, then use the existing application migration backup procedure with explicitly inventoried roots. Preserve the old application artifact separately. Never copy live SQLite files or remove WAL/locks manually. The backup excludes Keychain secret values; it preserves their references. See [Application migration](APPLICATION_MIGRATION.md).

| Acceptance scenario | Required evidence |
| --- | --- |
| Existing profile opens | Same profile IDs, conversations, messages, models and provider connection references |
| Existing Code projects open | Same project/session IDs, worktree paths, checkpoints and external state bindings |
| Pending review survives | Decision remains pending and tied to the original run/revision; no automatic approval or effect replay |
| Restart/crash recovery | Existing ownership, lock and recovery semantics remain intact |
| CLI and extracted app share state | Compatible coordinator negotiation and single-owner behavior; no second writer or duplicate operation |
| Existing credentials work | Packaged app accesses existing entries without re-entering API keys or copying them to files/logs/renderer state |
| App rollback | Previous artifact reopens compatible state; if restoration is required, use the verified backup/rollback procedure and preserve post-backup changes |

Test both credential paths and configured provider/integration references. In-memory SecretStore fixtures do not establish real Keychain continuity. A macOS packaged rehearsal with the existing installation is a separate gate, with no secret contents in evidence. Matching service names alone does not guarantee access: signing requirements, ACLs and helper identities can cause OS prompts. Do not promise a silent transition until verified. If the current signing identity cannot be reproduced, record that as a release blocker and handle the identity transition separately.

Exit gate: fixture tests and the installed continuity rehearsal pass; remaining production-signing limitations are explicit.

## Phase 5 — Cut over Harness and release ownership

Only remove Desktop from the current Harness tree after the destination and continuity gates pass.

- Remove `packages/desktop` in an ordinary commit. Preserve all prior commits and release references.
- Update root workspaces, dependencies, lockfile, scripts, TypeScript scope, `check-workspaces.ts`, architecture checks, documentation checks and CI. Retain engine/CLI tests and shared application contracts; do not delete tests simply because their old paths included Desktop.
- Keep core/CLI publication names and stable API signatures. Keep reusable migration/recovery tooling with the state owner in Harness.
- Replace current Desktop development links with the new repository; retain historical evidence with immutable source links. Add a clear ownership notice to avoid accepting new Desktop changes in the old location.
- Run Harness build, typecheck, architecture/workspace/docs/contract checks, core and CLI suites, package smoke and migration checks. Run App standalone CI against the final Harness artifact and the cross-client compatibility fixture.
- Release App independently with an exact supported Harness version/hash and protocol/state compatibility record. Core changes do not automatically force App updates; adoption requires App CI. Keep an integration workflow for testing new core candidates without changing the pinned release dependency.

Exit gate: Harness is independently buildable with only core and CLI, App is independently buildable, and both pass the shared-state compatibility scenario.

## Rollback and stop conditions

Before cutover, discard or repair the extraction clone while the original repository remains authoritative. After cutover, restore Desktop to the current Harness tree through a revert of the removal commit if needed; never reset or rewrite shared history. Pause App releases and use the recorded previous artifact.

Stop cutover on missing history, source-only imports, an unrepeatable build, changed profile/credential identifiers, broken cross-client ownership, unreadable existing state or failed packaged credential access. A source rollback is not a data rollback: use the backup procedure only when required, with writers stopped and fresh state checks. Do not automatically downgrade a database across unsupported schema versions.

## Suggested implementation units

1. Harness PR: inventory/provenance manifest and artifact-only Desktop tooling/tests.
2. New App repository: filtered history, independent configuration and CI; no behavior or identity changes.
3. App verification change: migration/continuity evidence and compatibility manifest.
4. Harness PR: remove Desktop, update checks/CI/docs, preserve core and CLI releases.
5. Separate product work: login, account service, plan enforcement and explicit offline policy. Store account tokens separately from provider keys; account logout must not erase existing local projects or provider credentials by default.

Completion means all five extraction phases pass. Login implementation, branding changes and production distribution certification are not prerequisites for moving source, but must not be reported as completed by that move.
