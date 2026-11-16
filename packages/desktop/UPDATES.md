# Desktop update trust

## For users

Automatic updates are disabled in the current alpha. Follow [Installation](INSTALLATION.md)
for manual replacement while preserving data. Signed updates require production
publisher configuration and validation before they can be enabled.

## Release operator reference

`update-trust.json` is build-owned configuration bundled into the host. The default
is explicitly disabled. This prevents network checks until a release operator has
configured a real feed, public key, publisher identity and channel. Renderer IPC,
environment variables and downloaded manifests cannot replace this configuration.
The build rejects invalid configuration before replacing build outputs.

An enabled configuration requires `schemaVersion: 1`, `enabled: true`, `feed`,
`publicKey`, `teamId` and `channel` (`stable` or `prerelease`). `publicKey` is a PEM
Ed25519 public key, never a private signing key. `teamId` is the ten-character Apple
Developer Team ID. `feed` must be a canonical HTTPS JSON release asset in
`github.com/Zhivex/zhivex-harness`, under `releases/latest/download/` or
`releases/download/<tag>/`. No production values are supplied in this checkout.

The feed serves the signed envelope expected by `update-manifest.ts`: base64url
`payload` and `signature` over the exact payload bytes. Signing keys belong in the
release system, not the repository or application. The payload binds product,
platform, architecture, version/channel, validity interval, readable state range,
and artifact URL/size/SHA-256. Native Developer ID and notarization verification
is a separate requirement at installation time.

The host fetches at most 32 KiB with a 15-second timeout and up to three approved
GitHub/CDN redirects. Requests omit credentials and reject compressed responses.
A current-version response must still pass full signature and policy validation;
it is not exposed as an installable artifact. Concurrent checks share one request.
The renderer receives only status and, when available, version/channel. Diagnostics
do not expose URLs, keys, server responses or underlying exception text.

The sidebar supports checking and downloading authenticated updates. Main owns the
manifest and private staging paths; renderer requests have no arguments. Concurrent
checks/downloads share the active operation. Downloads verify exact size and SHA-256,
remove partial files on failure and allow retry. Rechecking removes the prior staged
artifact before selecting another version. Downloading does not pause project work.
The downloaded state offers “Instalar y reiniciar”. Main closes admission to new
application IPC and refuses active work without cancellation. It pauses idle runtime
services, rechecks the artifact, mounts the DMG read-only, verifies and stages the
candidate on the installation volume, then detaches the image. Only then does it
close services, acquire exclusive state leases and back up every registered project
and task. A durable job pins the application and state receipts before recovery is
armed. Main exits only after the worker acknowledges the complete descriptor handoff.

The worker confirms installation or rollback, releases state leases and asks macOS
to reopen the verified application. An interrupted update is located by its exact
active recovery receipt on startup, before registries open; a new worker resumes
that job. Ambiguous failures retain the recovery gate and show a fixed diagnostic.
A missing or ambiguous job never authorizes a guessed restore. Failures before the
recovery gate resume idle runtimes or reload after their closure.

The current state format remains 1; incompatible future formats are rejected, not
implicitly migrated. SQLite exclusion is cooperative for current Harness clients;
older clients and arbitrary direct SQLite libraries do not honor its lease protocol.
Their exclusion is not certified by these tests. Do not treat the native image
rejection test or fixture handoff tests as a successful signed production update.
Production trust values, Developer ID and notarization remain deferred. The default
build keeps updates disabled until that configuration is supplied.
