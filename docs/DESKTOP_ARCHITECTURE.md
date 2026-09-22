# Desktop architecture

The desktop uses Electron and React with a separate Harness runtime process. It
shares the [client protocol](CLIENT_PROTOCOL.md) and [local service](LOCAL_SERVICE.md)
with other clients. Development uses Bun; installed application processes use
Electron's bundled Node runtime. macOS arm64 is the supported alpha target.

## Process and trust boundaries

- **Renderer:** bundled local React UI in sandboxed Chromium, with
  `nodeIntegration: false`, `contextIsolation: true` and `webSecurity: true`.
  Navigation, new windows, webviews and permission requests are denied. The CSP
  blocks network connections, inline scripts and frames; packaged fonts may use
  embedded data URLs. Repository and model text cannot introduce executable HTML.
- **Preload:** a narrow typed bridge for projects, sessions, activity, model
  selection, review, tasks, Git delivery, credentials and update status. It exposes
  no arbitrary shell, filesystem, environment or IPC-channel API. The authoritative
  interface is `desktop/src/bridge.ts` in the source checkout.
- **Main:** validates the sender, exact local page and main frame, and checks all
  arguments. Native selection supplies project paths; renderer requests use registered
  project keys. Main manages runtime ownership, review receipts, Keychain access,
  delivery and update coordination. It sends bounded, redacted projections to React.
- **Utility process:** owns the actual Harness engine, SQLite and tools. Authenticated
  owner-private Unix transport retains revision, approval, lease and replay checks.
  Policy decisions remain in the host/service, never in the renderer.

A repository, model output or compromised renderer cannot authorize an effect by
inventing a button or IPC call. Main, preload, runtime and bundled resources remain
trusted code. Same-user malicious processes are outside the local authentication
boundary; file permissions do not replace operating-system user isolation.

## Projects, sessions and recovery

Each project has an independent runtime and durable conversation scope. Navigation
reads state without starting a run. Asynchronous results are scoped to the selected
view. A single application instance owns the project catalog; a duplicate launch
focuses the existing window.

Renderer reload recovers durable activity and decisions. Reopening a project only
recovers stale transport after confirming that its prior owner is dead. Normal
application shutdown drains accepted work. Crash recovery preserves pending approvals
and reconciles effects without blindly replaying them; missing or ambiguous evidence
must not be presented as a successful operation.

Worktrees start from the source repository's committed state. Removal requires a
fresh review of dirty files, integration state and locks; the branch and conversation
history are retained. Git commit, push and PR delivery use reviewed state, operation
journals and explicit reconciliation after a lost response.

## Review and credentials

Main issues bounded, single-use review receipts tied to project, session, run,
revision, approval identity and expiry. The renderer sends the receipt and explicit
decision; it cannot supply trusted signatures or invoke unrestricted approval resolution.
File previews bind full source bytes where required, distinguish fragments from full
replacements, and disable approval for incomplete, stale, protected or redacted input.
OCI previews retain patch and verifier identity. An ordinary check receipt does not
by itself bind success to the exact bytes of an earlier edit.

Model choices persist by project. Active runs, approvals and recovery prevent unsafe
model switching. Provider keys live in separate macOS Keychain accounts and travel
through private host/runtime channels, not renderer state, command arguments or
child-process environment variables. Known credentials are rejected at the SQLite
boundary before persistence; this does not retroactively scrub historical data or
promise detection of every possible encoding.

## Distribution and updates

Bun bundles application code and dependencies. Packaging copies build output and
minimal metadata, excluding source, dependency caches and credentials. SQLite uses
Electron's `node:sqlite`; a separate Node installation is unnecessary. Git, GitHub
CLI and an OCI engine remain external prerequisites for their respective features.

The updater is integrated with main/UI and startup recovery. It checks signed
manifests, validates downloaded bytes and native publisher identity, coordinates
idle runtimes, acquires state leases, backs up registered state and performs a durable
worker handoff. Recovery uses the exact recorded application/state receipts. Current
SQLite clients participate in the lock protocol; arbitrary direct SQLite libraries
and older clients are not certified by that protocol.

The local build is unsigned and unnotarized. Production update trust is disabled
until a real feed, signing key and publisher identity are configured. A positive
signed install/update/rollback demonstration remains required before production
distribution; fixture success is not a substitute.

## Maintainer guides

- [Desktop setup and reproducible checks](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md)
- [Model selection and credential behavior](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/MODELS.md)
- [Installation and platform limits](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/INSTALLATION.md)
- [Update trust and recovery protocol](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/UPDATES.md)

Automated Electron checks cover packaged offline behavior and process isolation.
Live provider calls, real OCI execution, live GitHub authentication and signed
production distribution require their own evidence. Historical acceptance snapshots
remain in the [report archive](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/README.md).
