# Desktop architecture decision — HAR-HU-26

Status: accept Electron + React for the alpha, following the executable macOS arm64
spike on 2026-09-20. This is an architecture validation, not the complete desktop
product or a signed installer. HU27–35 retain their own acceptance criteria.

## Process boundary

React renders bundled local content inside a sandboxed Chromium renderer with
nodeIntegration false, contextIsolation true and webSecurity true. A CSP prohibits
network connections, inline scripts, frames and arbitrary resources. Navigation,
new windows, webviews and permission requests are denied. Repository text is rendered
as text; there is no HTML interpreter, shell bridge or arbitrary filesystem API.

The isolated preload exposes projects(), chooseProject(), openProject(),
initialProject(), command() and events(). Project paths originate in the native
picker or a trusted launcher argument; renderer commands use registered project
keys and cannot supply arbitrary paths. Main checks
the exact local page URL, WebContents identity and main frame on every request. It
validates the strict HU21 envelope, rejects renderer project/workspace overrides and
binds its host-selected project. Tokens remain in main and the owner-private service
file. Main strips rich CLI output and approval payloads from run responses, redacts known
host credentials, and sends allowlisted durable activity to React. A separate
Electron utility process owns the actual Harness, SQLite and tools.
Its Unix socket uses the existing HU22–25 authentication, authorization and replay.
No policy decision is delegated to the renderer.

## Runtime and packaging evidence

- Electron 44.4.3 includes Node 24.21.0 in both main and the utility process. This
  satisfies the Harness Node >=22.13.0 requirement. React 19.3.0 is locked separately
  under desktop/bun.lock; the library package has no new production dependencies.
- The packaged macOS arm64 .app starts from a fresh external working directory and
  temporary HOME, opens the real window, creates SQLite, streams an offline response
  and cancels an active run. Assertions verify no require/process in the renderer,
  only the declared bridge methods, a different runtime PID and rejected forged
  project/workspace fields. Screenshot and machine report are emitted by the smoke.
- Bun bundles the runtime dependencies and UI. SQLite uses Electron's node:sqlite;
  no native addon recompilation is needed. The runtime version is embedded from the
  root package metadata. Build transforms remove source-path-dependent createRequire
  usage; installed execution does not need the checkout or a separate Node install.
- OCI smoke on this Mac passed with Docker 29.8.0 and image
  sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6.
  Docker remains an external optional prerequisite; it is not bundled or certified
  by the Electron smoke. The OCI backend preserves its separate governed policy.

## Threats and remaining limits

A repository or model response is untrusted; neither may create controls or choose
IPC channels. A compromised renderer must still pass the service's strict revision,
identity, approval and expiry checks. Main/preload/runtime and bundled resources are
trusted code and need distribution integrity and updates. A same-user malicious
process is outside this local authentication boundary; file mode checks are not
an operating-system user isolation substitute.

HU27 adds the native project picker, private recent-project catalog, per-project
runtimes and conversation navigation. Selection queries state without starting runs.
Responses are scoped to the selected view to prevent cross-project races. One app
instance owns the catalog; duplicate launch focuses the existing window. Runtime
startup failures fail closed; dead-owner recovery is explicit.
Closing the app drains accepted work; this may take until the configured timeout.
Renderer reload during a running stream is verified in HU28; process-crash recovery
and the full approval journey belong to HU30. A missing
provider key produces a runtime error; secure credential UI is HU33. Production
configuration and OCI onboarding must not silently assume Docker is present.

The unsigned .app is approximately 310 MB on this Mac. Only darwin arm64 is tested;
Intel/universal and other platforms are not supported by this evidence. Developer
ID signing, hardened-runtime entitlement validation, notarization, Gatekeeper clean
installation and updater integrity remain open. Per user instruction, prepare the
packaging now and configure signing later; unsigned output does not satisfy HU34.

## Reproduction

See [desktop/README.md](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md).
Development uses Bun; product processes use the Node runtime shipped with Electron.
No live provider call occurs in fixture smoke mode.

## Primary references

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): sender validation, isolation and limited privileged bridges.
- [Process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox): renderer and preload boundaries.
- [Utility processes](https://www.electronjs.org/docs/latest/api/utility-process): separate Node-capable service process.
- [Electron releases](https://releases.electronjs.org/?channel=stable): Electron 44.4.3 / Node 24.21.0, checked against the running artifact.
