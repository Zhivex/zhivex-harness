# HAR-HU-34 — Local installer preparation

In progress. Developer ID signing and notarization are explicitly deferred by the
user. This increment does not close signed distribution acceptance or publish files.

`desktop/scripts/prepare-installer.ts` stages the packaged app with preserved
framework symlinks, an Applications link, installation instructions and versioned
release notes into a read-only compressed DMG. It verifies the image and emits a
manifest with the DMG SHA-256/size, ASAR/helper hashes, desktop/Harness/Electron
versions, architecture, minimum compilation target, host OS, source commit reference
and explicit working-tree-dirty status. A dirty source reference is not presented
as a complete reproducible source identity. The manifest explicitly records no
Developer ID signature, notarization or publication.

The script refuses mismatched app/runtime package versions, bundle ID, architecture
or minimum target. Build now embeds runtime-metadata.json from the same metadata
used for bundling. An actual compatibility defect was found and fixed: the helper
previously targeted the build host's macOS 27 while Electron declared 13.0. Swift
now explicitly targets arm64-apple-macos13.0; vtool and app metadata agree. This is
compilation-target evidence, not runtime certification of every older macOS release.

`desktop/INSTALLATION.md` explains bundled Node/Electron, arm64-only scope, optional
external OCI dependencies, Git/gh requirements, ordinary filesystem/Keychain/network
permissions and uninstall that preserves state, repositories, task worktrees and
Keychain entries. It does not tell users to disable Gatekeeper for unsigned code.

Reproduce after packaging:

- `bun run desktop/scripts/prepare-installer.ts`
- `bun run desktop/scripts/smoke-installer.ts`

The installation check verifies the DMG digest, mounts it read-only, copies the app
into a temporary Applications folder, verifies copied ASAR/helper bytes and detaches
the image before launch. It invokes the existing full desktop smoke from that copy
with a clean temporary profile and local fixtures, then runs the copied native
helper's temporary-keychain self-test. It never changes /Applications or a personal
profile, and does not certify downloaded/quarantined Gatekeeper behavior.

The source app version remains 0.1.0-alpha.1 and Harness runtime 1.0.0; this is a
local unsigned candidate, not a beta release declaration. Actual signing/notarization,
clean downloaded installation and signed helper identity remain outstanding. HU35
update/migration/recovery work is also still outstanding. No branch push occurred.

Validation passed: desktop typecheck, DMG integrity verification, the full desktop
smoke from the detached-image installation copy, and that copy's native Keychain
helper self-test. SQLite, separate runtime, streaming, cancellation, approval
recovery, crashes, project isolation and fresh-profile startup passed. Evidence:
HAR_HU_34_INSTALLER_MANIFEST_2026-09-20.json and
HAR_HU_34_INSTALLATION_CHECK_2026-09-20.json. Documentation check passed.
