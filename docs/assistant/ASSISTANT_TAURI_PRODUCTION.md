# Tauri production preparation

Status: local release tooling and update/rollback primitives validated with fixtures.
Not a production release or an enabled automatic updater. The existing local pilot
and all user state remain unchanged. Target: macOS arm64 only.

## Release identity and signing

The current identifier remains `ai.zhivex.assistant.preview`, executable
`zhivex-assistant-desktop`. Changing that identity is a separate migration decision.
Use a new numeric three-component version in `src-tauri/tauri.conf.json` for each
release, then build with the existing `build:desktop` command. Do not relabel an
already signed bundle. Do not move the Assistant state directory or credential
service as part of a binary update.

Create a private operator configuration outside the checkout:

```json
{
  "application": "/absolute/path/Zhivex Assistant.app",
  "outputDirectory": "/absolute/existing/parent/release-0.2.0",
  "version": "0.2.0",
  "teamId": "YOURTEAMID",
  "signingIdentity": "40_HEX_CHARACTERS_FROM_SECURITY_FIND_IDENTITY",
  "notaryProfile": "assistant-release"
}
```

Replace placeholders with the actual Developer ID Application certificate's
SHA-1 fingerprint and ten-character Apple Team ID. Store notarization credentials
with `xcrun notarytool store-credentials`; never put passwords, API private keys or
update signing keys in this configuration, the repository, app resources, or logs.
The output parent must exist; the output directory must not exist.

From `packages/assistant`:

```sh
bun scripts/release-macos.ts inspect /absolute/path/release-config.json
bun scripts/release-macos.ts package /absolute/path/release-config.json
```

`inspect` checks the actual bundle, inventory, native files and local certificate
availability without signing or uploading. `package` requires that certificate,
copies the app into a new directory, signs every Mach-O file (including native
Node modules), regenerates the runtime inventory after signing, then seals the
outer app. Node alone receives the JIT entitlement. It submits a ZIP to Apple,
requires Accepted, staples and validates the app, checks the pinned Developer ID,
version, arm64, hardened runtime and Gatekeeper's notarized origin, and then
creates, signs, notarizes and staples the DMG. Failures preserve evidence for
inspection. A timeout may leave a pending Apple submission; inspect its status
before starting another release in a fresh output directory.

Real signed Node startup and native module loading must still be tested on a clean
Mac. Do not broaden entitlements to work around a failure without investigating it.
This pipeline does not install, publish, modify the source bundle, or touch user data.

## Trusted updates

`src/release/update-manifest.ts` and `update-download.ts` adapt Desktop's authenticated
Ed25519 envelope and bounded download contracts. Product identity is specific to
Assistant; key, channel, current version and state schema must come from trusted
host/build configuration. The feed cannot supply its own trust key. Verification
rejects expired or replayed versions, foreign products, incompatible schemas,
wrong channels and non-allowlisted artifact locations. Download verifies exact
size and SHA-256, limits redirects to GitHub release hosts, omits credentials,
enforces a deadline and removes partial downloads.

The allowlist is `https://github.com/Zhivex/zhivex-harness/releases/download/<tag>/<file>.dmg`.
No feed or production public key has been configured. This is the existing
Desktop envelope protocol, **not** the Tauri updater plugin's Minisign format.
Do not feed these signatures to that plugin or enable a second installer alongside
the recovery transaction. No renderer update capability or automatic installation
has been enabled.

The offline signer accepts a descriptor with `currentVersion`, `stateSchema`, and
`manifest` matching `UpdateManifest` in `src/release/update-manifest.ts`. Set exact
artifact URL, byte size, SHA-256, release version/channel, publication/expiry times
in epoch milliseconds (at most seven days), and the tested readable schema range.
Use an independently retained Ed25519 PKCS#8 PEM key owned by the publisher with
mode 0600; pin its public key in the eventual host policy through a reviewed build.

```sh
bun scripts/sign-update-manifest.ts descriptor.json /private/key.pem release.dmg update.json
```

The signer verifies the artifact bytes and validates its own envelope before
writing an exclusive output file. It does not prove the DMG was notarized: only
sign an artifact produced and validated by the release pipeline. Neither script
publishes anything. Keep the private key backed up separately; key rotation needs
a bridge release trusted by the old key before replacing the pinned key.

## Recovery between versions

`src/release/application-swap.ts` adapts Desktop's same-volume, journaled bundle
transaction. It stages and re-verifies a candidate, retains `previous.app`, fsyncs
rename boundaries and supports idempotent recovery after interrupted activation
or rollback. Native verification pins the Team ID and exact version for both
bundles. It never deletes the previous bundle or converts state.

Activation and rollback require host-only `assertStopped` and
`assertStateReadable(version)` callbacks. A future coordinator must hold exclusive
admission across those checks and all renames, stop the native shell, Node hosts,
PTYs, preview workers and Code attachments, and verify the state against the
target version's tested compatibility contract. The callbacks are not UI inputs.
Do not implement them as no-ops outside fixtures. The current app does not call
these primitives: a separately surviving installer/recovery coordinator is still
required before enabling in-app updates.

Binary rollback is allowed only when the previous version can read the current
state. Otherwise stop and retain both bundles and state. Never silently discard
work written by the newer version or copy a live SQLite/WAL directory. Recovery
across schema changes requires an offline, verified, scope-preserving backup and
explicit restoration policy; the stage 7 logical adoption flow is not a full
host-wide rollback backup. Keep Code/Desktop available during the pilot.

## Validation and remaining release gates

Validation on 2026-11-13: 225 Assistant tests passed, including 21 release tests;
TypeScript, architecture boundaries and documentation checks passed. The full
suite required local socket access outside the filesystem sandbox. Inspecting the
actual 0.1.0 pilot bundle found three native binaries and no matching certificate.
See [machine-readable evidence](../reports/TAURI_PRODUCTION_PREPARATION_2026-11-13.json).

Local tests cover signature tampering, expiry/channel/schema policies, corrupted
and stalled downloads, unsafe redirects, live-owner refusal, altered candidates,
each activation/rollback rename boundary, incompatible-state refusal, signing
order, inventory regeneration, notarization rejection and native identity checks.
Native signing/notarization commands are simulated in these tests; they do not
establish Apple acceptance or real signed runtime operation.

On this Mac `security find-identity -v -p codesigning` reports zero valid identities.
Required before production: install a Developer ID certificate and notarization
profile; choose and pin the production update key/channel; build two signed,
notarized versions; verify clean-machine startup, actual state compatibility and
upgrade/rollback including interruption; implement the exclusive recovery
coordinator and health-check handoff; then explicitly authorize publication.

References: [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
and [Tauri updater format](https://v2.tauri.app/plugin/updater/).
