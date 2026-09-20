# HU32 — reviewed local commit manager, in progress

This increment adds a host-only commit manager. It is not yet connected to the
renderer or main process, and does not implement staging, push or PR creation.
All three HU32 acceptance criteria remain open. The current desktop artifact is
still the HU31 candidate; this module is not an exposed packaged capability.

The caller must name exactly the staged paths and provide a commit message.
Review captures the branch, parent commit, tree, index digest, complete staged
before/after contents and modes, author/committer and local destination. It rejects
unmerged entries and interrupted merge/rebase/cherry-pick state. The UTF-8 preview
is bounded to 100 files, 256 KiB per blob and 1 MiB total. Binary data, symlinks,
submodules, protected paths, recognized secret patterns and supplied host-sensitive
values are refused before projection. Detection is bounded and is not a proof that
arbitrary text contains no secrets; broader delivery policy remains to be finished.

A five-minute one-use receipt authorizes the exact snapshot. Changed index, tree,
branch or parent invalidates it. The manager acquires the normal index lock, then
creates a commit object from the reviewed tree and updates only the reviewed branch
with an expected-old-HEAD comparison. It never stages, resets or overwrites working
files. Unstaged changes and untracked files remain intact. Hooks, diff drivers,
signing commands and shell evaluation are not used. User Git identity is read on
the host, including global identity settings; credentials are not sent to a model.
This commit primitive currently produces unsigned commits.

A private operation record is fsynced before the branch update. The accepted
review ID becomes the operation ID. Repeated calls and process restart reconcile
that record rather than producing another commit. A crash after the branch update
but before completion bookkeeping can be reconciled from the exact commit ID.
If an incomplete operation cannot be confirmed, it reports unknown and never
repeats the branch mutation. Review receipts without an accepted operation do not
survive restart. This manager assumes the desktop's single-owner execution model.

Validation: five real-Git tests, 28 assertions, zero failures; desktop typecheck
passes. Cases cover exact staged selection, preserved unstaged/untracked content,
retry after completion/reopening, simulated interrupted completion bookkeeping,
stale index, another client's commit, held index lock, secret/path/binary refusal,
merge state, hook/diff-driver nonexecution and invalidation on restart. No remote
operation or provider call was made. Tests create and remove their own temporary
repositories only.

Remaining: user-visible file selection/staging and review; main/preload admission
and runtime coordination; push and PR reviews with explicit destinations and host
credentials; stale-remote/network/conflict recovery and no-duplicate PR semantics;
packaged user journeys. The user's work remains local on `feat/harness-desktop`;
no push is authorized for delivery of this implementation.
