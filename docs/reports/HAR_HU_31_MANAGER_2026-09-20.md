# HU31 — host-side managed worktree manager

In progress; all three Notion acceptance criteria remain open until UI/runtime
integration and packaged user-journey verification are complete.

The new manager persists UUID task identities and source-project identity, title,
branch, initial commit/integration ref, checkout and separate runtime-state paths.
Creation explicitly requires `initialState: committed-head`; it creates a new
`feat/` branch at the resolved commit. The original index, worktree and untracked
files are preserved. New files are checked out without force or implicit repository
programs. Hooks, fsmonitor, clean/smudge/process filters, recursive submodules and
file/ext network protocols are disabled for the Git operations used here.

The private index is written before creation. Failures retain an actionable record
and never delete a branch or partially created directory. On opening after an
interrupted creation, the record becomes needs-attention without replaying Git.
The manager assumes one desktop owner, matching the app's single-instance model;
mutations within that owner are serialized.

Cleanup reviews the exact registered worktree, common repository and branch,
current HEAD, current integration-target commit, dirty/ignored paths, exclusive
commit count and Git lock. A five-minute, one-use host receipt binds that snapshot.
Removal rechecks it, refuses unintegrated data/locks and invokes normal Git removal
without force. The branch, task record and separate runtime-state path are retained.
No repository data is copied to the source or silently discarded.

Validation: six integration tests passed, 47 assertions, with real temporary Git
repositories. They cover two concurrent task requests, independent edits and index
reopening; preservation of staged/unstaged/untracked source files; dirty/ignored
cleanup refusal; unmerged commits and subsequent integration; stale/single-use
reviews; branch retention; native locks; hostile hook/filter nonexecution; branch
collisions; forged persisted paths; interrupted creation without replay. Desktop
typecheck passed. The fixture removes only its own temporary repositories.

Remaining: main/preload authorization boundaries and UI; task-to-session/runtime
association using the separate state directory; visible status and removal review;
packaged demonstration of two concurrent tasks, restart and cleanup. No HU31
completion, desktop package capability, push or publication is claimed here.
