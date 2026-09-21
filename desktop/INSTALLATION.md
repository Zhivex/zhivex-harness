# Install Zhivex Harness for macOS

## Current availability

The local alpha candidate is **unsigned and unnotarized**, not an Apple-verified
beta distribution. Signing and notarization remain distribution requirements.
Do not disable Gatekeeper or remove quarantine to conceal this state.

Desktop targets Apple Silicon (arm64), with a minimum build target of macOS 13.
This is not proof of testing on every supported macOS version. Intel is unsupported.
The packaged app includes Electron, Node and native credential/update helpers.
You do not need Node, Bun or the npm CLI installed separately.

Git is required for repository work. GitHub CLI and authentication are needed for
GitHub delivery. Provider credentials do not configure GitHub authentication.

## Local installer

1. Compare the DMG SHA-256 with `release-manifest.json` using `shasum -a 256`.
   A hash detects byte changes; an unsigned manifest does not authenticate the publisher.
2. Open the DMG and drag Zhivex Harness.app into Applications. Close tasks and the
   app before replacing an installation; retain the previous app until verification.
3. Open the app. Gatekeeper blocking this unsigned candidate remains a distribution
   limitation; it is not a request to bypass that protection.
4. Open a repository, choose a model and configure the provider key in **Credentials**.
   The key is entered through a native dialog and stored in macOS Keychain.

The folder picker uses ordinary file permissions and does not request full disk
access. Keychain may request permission or unlocking. Provider and GitHub connections
require network access.

## Isolated execution

Docker, Podman and OCI images are not bundled. Operations requiring OCI cannot start
without a compatible running engine and image. See the [support matrix](../docs/SUPPORT_MATRIX.md)
and [execution guide](../docs/EXECUTION_ENVIRONMENTS.md). OCI is never silently
replaced with direct host execution.

## Updates

Automatic updates are implemented but disabled in the current configuration. They
require a signed feed, publisher identity and validation of a signed update. Replace
this local candidate manually. See [Updates](UPDATES.md).

## Uninstall while preserving data

Close tasks and the app, then move only Zhivex Harness.app to Trash. Preserve
`~/Library/Application Support/zhivex-harness-desktop` (or the installation's
`userData` path), original repositories, task worktrees and project `.zhivex-harness`
state. Do not delete state directories or Keychains during uninstallation.

Keys remain in Keychain. To remove them, use **Eliminar clave del llavero** before
removing the app. Keep a verified backup of state before migrations or version changes.
