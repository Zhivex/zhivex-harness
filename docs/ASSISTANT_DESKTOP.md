# Assistant primary graphical interface (Tauri 2)

The standalone browser entrypoints are retired; see [the retirement policy](WEB_RETIREMENT.md).

For the proposed project coding experience and reuse of Code/Electron Desktop, see the
[Tauri agent workspace implementation plan](ASSISTANT_TAURI_AGENT_PLAN.md).

This preview opens the existing Assistant React UI in a native window. Harness
remains the engine, the CLI remains available, and Code is **not removed**. The
migration to one GUI is incremental: review and approval flows are the existing
Assistant/host flows, not replacements implemented in Rust.

## Try it on a Mac from source

Prerequisites: macOS, Xcode Command Line Tools, Rust/Cargo, Bun 1.4.3 and
Node >=22.13.0. Use a supported Node release (22 or 24 recommended). The build
uses the Node executable on PATH and builds for the current machine. Do not use
cross-compilation to produce a release with a mismatched Node or native keyring.

From the repository root, on branch `feat/assistant-tauri-preview`:

```sh
git fetch origin
git switch --track origin/feat/assistant-tauri-preview
bun install --frozen-lockfile --ignore-scripts
bun run prepare:assistant
bun run --cwd packages/assistant build:desktop
open 'packages/assistant/src-tauri/target/release/bundle/macos/Zhivex Assistant.app'
```

If the branch already exists locally, switch to it instead of using `--track`.
Do not reset or overwrite local changes to update it. On a new Mac, build there
rather than copying the Mac mini's architecture-specific development output.
The resulting app includes Node, production JS dependencies, the current built
Harness candidate and React assets. It no longer depends on the checkout's
location or a system Node at launch. `build:desktop` rebuilds both Harness and
Assistant before staging; it fails if the registry engine dependency pins and
the candidate's pins differ. This is a development preview, not a signed,
notarized installer or an automatic update channel.

The app uses `~/.zhx-app`, the same managed profile/history and system Keychain
as the existing web launcher. Close that launcher/service before opening the
native app. A second independent launch reports an error rather than stealing
the lock or launching another engine. No existing data is migrated or deleted.
For an isolated trial without existing profiles, run the binary directly:

```sh
ASSISTANT_DESKTOP_DIRECTORY="$(mktemp -d)" \
  'packages/assistant/src-tauri/target/release/bundle/macos/Zhivex Assistant.app/Contents/MacOS/zhivex-assistant-desktop'
```

Complete the normal setup in the window to use a real provider. Saving/testing
a provider can consume quota; offline verification does not certify a live
provider, OAuth, Telegram, microphone, or notifications. There is no new voice integration; system notifications are opt-in.

## Lifecycle and security

- Rust owns one Node child and a private stdio readiness channel. The bearer URL
  is never printed into native logs, command arguments, or a temporary access file.
- Node listens on loopback with the existing bearer, Origin, review, expiry and
  approval checks. The existing CSP is served by that HTTP host.
- The native webview has no Tauri capabilities, filesystem commands, shell plugin,
  or JavaScript-to-native command interface. Navigation stays on the selected
  loopback origin. HTTPS external links/OAuth open in the system browser.
- Closing the window hides it and keeps tasks running; reopen it from the Dock.
  Quit and Settings → Shut down Assistant use the controlled lifecycle.
- Normal closure sends a cooperative stop, waits up to five seconds, then kills
  an unresponsive child. A lost parent pipe also stops Node. Startup has a
  90-second budget for Keychain/restoration. An unexpected host exit presents a
  safe restart message; it does not silently rerun a task.
- Credentials remain in the OS credential store, never copied into the bundle.
  The build stages allowlisted outputs only, not `.env`, histories or user data.

## Checks

```sh
bun run check:assistant
bun run --cwd packages/assistant test:desktop
bun run --cwd packages/assistant smoke:desktop
bun run smoke:assistant:web
```

`smoke:desktop` checks the staged Node binary, HTTP assets, unauthorized access,
duplicate instance rejection, shutdown, restart and parent EOF, using a fresh
temporary directory. To check the actual macOS bundle instead:

```sh
bun run packages/assistant/scripts/smoke-desktop.ts \
  'packages/assistant/src-tauri/target/release/bundle/macos/Zhivex Assistant.app/Contents/Resources/runtime'
```

The Rust unit test validates the readiness URL boundary. Existing offline
Assistant tests cover conversation, persistence, review and approval behavior.
A local successful build does not imply cross-platform or release certification.

## Windows and Linux

Tauri and the Node bridge are structured for all three desktop platforms, but
only macOS has been built and exercised in this preview. Build on the target
platform with its own Node and native dependencies; do not copy `runtime/`
between operating systems or architectures.

- **Windows:** requires Rust's MSVC toolchain, C++ Build Tools, WebView2, Node,
  Bun and `tar`. A future native bundle can override the macOS bundle target
  with `bun run tauri build --bundles nsis` after staging. **Not currently
  supported:** the managed host still enforces POSIX uid/mode directory checks;
  these must be adapted to Windows ACL semantics and tested before claiming
  Windows support. Review credential-store behavior and lifecycle there too.
- **Linux:** requires Tauri's WebKitGTK 4.1/build prerequisites and a running
  Secret Service/keyring session. After staging, use `bun run tauri build
  --bundles deb` or `--bundles appimage` from `packages/assistant`. These packages
  and their sandbox/keyring behavior have not been validated here.

Before distribution: native CI on each target, license/notice inventory,
signing/notarization, installer/uninstaller behavior, upgrade/recovery testing,
OAuth round trips, and an explicit background-work policy are still required.

## Stage 4 terminal and background operation

The macOS preview now includes a real project terminal and a persistent activity queue.
Closing the window keeps tasks and terminal jobs running; use the Dock to reopen it.
Quit offers wait/cancel handling and ends terminal jobs. Restart reconciles saved agent
state without replaying interrupted effects; terminal sessions are not restarted.
System notifications are opt-in. See [stage 4](ASSISTANT_TAURI_STAGE_4.md) for ownership,
recovery, permission, and verification details.

## Stage 5 tasks and Git delivery

The workspace now offers managed tasks on separate worktrees and reviewed local
commit, GitHub HTTPS push, and draft PR flows. Task creation starts from committed
HEAD and excludes source changes that have not been committed. Two task runtimes
can remain open concurrently; removal requires a clean, integrated, unlocked
worktree and a fresh review. See [stage 5](ASSISTANT_TAURI_STAGE_5.md) for execution
limits, recovery, transport prerequisites, and the boundary with child delegation.

## Preview and browser evidence

The project workspace includes reviewed static previews, bounded Chromium checks and
artifact-linked feedback. See [stage 6](ASSISTANT_TAURI_STAGE_6.md) for the supported
static-output flow, browser prerequisite, compatibility with existing approvals and limits.

## Packaged local pilot

Stage 7 adds bundle integrity checks, prerequisite diagnostics and conservative migration
preflight. Code remains available; production distribution is still gated. See the
[stage-7 pilot runbook](ASSISTANT_TAURI_STAGE_7.md) for supported architecture, migration,
credential references and rollback boundaries.
