# Desktop update trust

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

The sidebar currently supports checking only. Installation/download coordination
with main is still pending; no button in this version starts installation. Signing
and notarization remain deferred. Enabling feed checks does not complete HU35 or
certify a signed successful update.
