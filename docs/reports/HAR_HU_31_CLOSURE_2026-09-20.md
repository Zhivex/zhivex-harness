# HU31 — managed task worktrees: implementation closure

All three acceptance criteria are implemented and verified locally. Delivery is
pending publication. This is an unsigned macOS arm64 desktop candidate; signing,
notarization, real-provider/OCI certification and the remaining beta stories are
separate work. Signing preparation follows the user's explicit deferral.

## User behavior and boundaries

“Tareas aisladas” creates a persistent task with a title, optional new `feat/`
branch, UUID identity, base commit and visible status. Creation requires explicit
acceptance of the committed-HEAD policy. The source repository's staged, unstaged
and untracked files are neither copied nor modified. Git filters/hooks do not run.

Each opened task has a distinct runtime process and a private state directory
outside its checkout. Conversations and runs remain scoped to that task. Switching
tasks does not cancel active work; reopening the application preserves identities,
branches, files, sessions and run history. The renderer can select known IDs but
cannot supply arbitrary workspaces or runtime state directories.

Cleanup requires a five-minute, one-use host review bound to the registered Git
identity, HEAD, current integration commit, pending/ignored paths, exclusive commits
and lock state. Dirty, unintegrated or locked worktrees cannot be removed. The host
pauses admission, refuses active runtime work, closes an idle worker and rechecks the
review before ordinary Git removal without force. It retains the branch, task
record and conversation state. Application shutdown waits for accepted task
creation/removal before draining workers.

Removed records remain visible, but archived conversation browsing and automated
repair of interrupted creation are not exposed. Interrupted creation is preserved
as needs-attention without Git replay. The bounded task catalog holds 500 records;
source projects remain subject to the existing 100-entry recent-project catalog.
Missing or altered source/worktree identities fail rather than guessing a path.

## Verification

- `bun test`: 673 pass, zero fail, 3837 assertions across 90 files.
  Includes six real-Git manager tests for ignored/dirty/unmerged/locked worktrees,
  stale receipts, integration, hooks/filters, collisions and interrupted creation.
- Root and desktop typechecks, documentation and stable contract checks pass.
- `bun run --cwd desktop smoke:worktrees:packaged`: UI creates two tasks from a
  dirty source, simultaneously runs work in separate workers, rejects foreign
  sessions and forged creation inputs, independently modifies a fixture file,
  cancels both, closes every worker, restarts the whole app and recovers the same
  sessions. UI refuses dirty cleanup and removes the reviewed clean checkout while
  preserving its SQLite state. Source index bytes and staged/unstaged/untracked
  contents remain intact. Also passed in development Electron.
- `bun run --cwd desktop smoke:packaged --empty-start`: general desktop regression
  passes, including review, stale/expired approval rejection, renderer/runtime
  recovery, orphan cancellation, lost responses, project isolation and keyboard
  navigation. Its duplicate-submit selector now targets the prompt's form because
  task creation adds a separate form.
- `bun run --cwd desktop smoke:packaged --oci-review`: complete preview, explicit
  approval, host bytes and verified final diff pass with an offline OCI fixture.
  This does not certify Docker or contact a provider.

Evidence is archived in `HAR_HU_31_WORKTREES_PACKAGED_2026-09-20.json`,
`HAR_HU_31_REGRESSION_PACKAGED_2026-09-20.json` and
`HAR_HU_31_OCI_PACKAGED_2026-09-20.json`. The candidate's application-code ASAR hash
is recorded in `HAR_HU_31_CANDIDATE_2026-09-20.json`; it is not a signature or a hash
of the complete Electron distribution. Earlier manager-only evidence remains in
`HAR_HU_31_MANAGER_2026-09-20.md`. No push or publication performed.
