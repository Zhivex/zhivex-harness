# Zhivex Harness Desktop

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

Use the sidebar to find saved conversations. Conversations and pending approvals
survive restarts. The top panels provide Git delivery (**Entrega Git**), isolated
tasks (**Tareas aisladas**) and decision history (**Historial de decisiones**).
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
