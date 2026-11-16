# Zhivex Electron

The app opens the unified Assistant/Code shell backed by the shared core. The previous desktop UI and Tauri launcher have been removed. See [the application guide](../../docs/CODE_ELECTRON.md).

A local app for working on Git repositories with persistent conversations, model
selection, change review and explicit approvals.

**Alpha for macOS Apple Silicon.** The local package is unsigned and unnotarized.
Automatic updates are disabled until production trust is configured and a signed
update is validated. The stable npm CLI release does not make Desktop stable.
Desktop is distributed separately from npm and includes its own Node runtime;
users of the packaged app do not need to install Node, Bun or the CLI.

## Start using the app

1. Follow [Installation](INSTALLATION.md) for prerequisites and the current distribution limits.
2. Open a Git repository using the native folder picker (**Open repository**).
3. Create a conversation (**New conversation**). Suggestions fill the editor; they do not execute tasks.
4. Select a model at the bottom of the editor. In **Credentials**, save its provider key through the secure macOS dialog.
5. Send a task with Enter; use Shift+Enter for a new line. Review requested actions before approving them.

The desktop interface, native dialogs, and CLI use English. Without a key, you
can browse history but cannot send a task. Cancel stops active work; it does not undo completed effects.

## Conversations and changes

Use the sidebar to find saved conversations. The **•••** menu lets you rename or
archive a conversation locally; the **Archived** filter lets you restore it.
Unsent drafts are saved per conversation and restored when you return. Conversations and pending approvals
survive restarts. The top panels provide **Git delivery** and **Isolated tasks**; each run includes
**Decision history**.
Git delivery requires separate Git/GitHub authentication. Isolated tasks use
worktrees from the current commit and do not copy uncommitted changes. Cleanup
requires review and preserves the branch and conversations.

If a response is lost after an operation, inspect its persisted result before
retrying. An individual check does not automatically certify the bytes of a change.
Normal shutdown waits for accepted operations; forced termination may require
recovery. Do not delete lock files to force a project open.

## Guides

- [Models and credentials](MODELS.md).
- [Installation and uninstalling while preserving data](INSTALLATION.md).
- [Updates and recovery](UPDATES.md).
- [Development and packaging](DEVELOPMENT.md) for contributors.

### Background status menu

The unified macOS app installs a template icon in the menu bar. Its menu offers
**Show Zhivex**, **Hide window** and **Quit Zhivex…**. Show restores the existing
window (including a minimized window); it does not start another runtime.
Closing or hiding the window keeps background work active. Quit uses the same
coordinated shutdown as the application menu and keyboard shortcut: an app-owned
service requires confirmation, while an externally owned service is left running.
The icon is removed when Electron quits. This menu does not imply that work runs
after the service exits or while the computer is asleep.

The packaged autonomous smoke exercises the shared native Menu callbacks,
window visibility, continued host access while hidden, cancellation of Quit,
restart and worker recovery. It does not automate a pointer click on the macOS
menu-bar icon or certify VoiceOver interaction with the native menu.

The application credential adapter runs native Keychain calls in a short-lived
child using Electron's bundled runtime. Its entrypoint and native modules are
packaged outside the asar under `Resources/credential-runtime`. Requests use
private pipes, have an eight-second parent deadline, and are never replayed after
an uncertain write. Settings stay locked until an explicit reload reconciles the
saved state. This does not modify Keychain access permissions or certify the final
signed application identity.
