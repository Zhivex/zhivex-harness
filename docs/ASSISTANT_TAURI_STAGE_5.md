# Tauri stage 5: isolated tasks and Git delivery

Stage 5 reuses Code's coding composition and adapts Desktop's worktree, commit,
GitHub transport, push, and pull-request adapters into the Assistant host. The
renderer imports no privileged Git implementation. All actions use the existing
bearer/Origin-protected workspace API and registered project identities.

## Task ownership and limits

A task is a managed worktree on a new `feat/` branch from the source's committed
HEAD. Creating one requires acknowledging that staged, unstaged, untracked, and
ignored source files are not copied. Source files and the source index are preserved.
Task titles appear in the project sidebar; conversations, approvals, checkpoints,
terminal access, and task activity reuse the existing project workspace composition.
Internally each task uses its own registered project identity and service, not a
new assistant profile. The reserved `isolated-task` conversation context is not
needed to bypass or replace the existing project binding contract.

At most two managed task runtimes may be open per Assistant host. They can execute
concurrently, with separate stores and service credentials. Use **Close idle
environment** to release a slot without deleting files or history. Active runtime
operations cannot be silently closed. Background activity polling does not reopen
closed task runtimes. Other project runtimes retain the existing host-wide limit.

Task state and ownership locks live outside the task checkout. Each task persists
a selected limit of 1–20 steps (default 8). Every execution in that task also has
60,000 cumulative tokens, 50,000 input tokens, 10,000 output tokens, 40 tool calls,
5 tool errors, and a five-minute duration limit. Unlimited settings cannot override
these task limits. These are per-execution limits, not a monetary spending cap over
all follow-ups in a task. Local execution has the same OS/process authority as the
stage-1 local backend: a worktree is not an OS sandbox.

Task removal requires a fresh one-use review of the task identity, current HEAD,
integration ref, dirty/untracked/ignored files, unintegrated commits, and Git locks.
The host rechecks immediately before ordinary `git worktree remove`; it never uses
force or deletes the branch. Task records and runtime state remain for recovery.
Interrupted creation is surfaced as needing attention, never automatically repeated.

Git mutations and removal pause the relevant service and reject active work. They
also reject an open human terminal in that project; close the terminal explicitly
first. Global drain includes outstanding task/Git operations. Returning from a
global drain cannot release a concurrent Git operation's admission pause.

## Reviewed delivery

The Git panel supports explicit file selection/staging, complete before/after review
with invisible characters revealed, local commit, GitHub HTTPS push, and draft PR.
Commit review includes the whole staged selection, message, identity, branch, and
HEAD. Foreign staged files, changed reviews, protected paths, binary/incomplete
previews, and detected secrets fail closed. Repository hooks, filters, diff drivers,
and signing do not run as a side effect of this flow.

Remote review includes the actual URL, destination ref, base ref, complete outgoing
commits, and file contents. Pushes are ordinary non-forced pushes of the reviewed
object to one ref. Network Git operations use a private bare repository to avoid
repository-local URL rewrites or credential helpers. Existing `gh` authentication
is used by host transports; credentials never pass through the renderer. A PR review
requires the exact head to be published and binds its title, body, base, and draft
status. This release offers GitHub HTTPS only; it does not add merge, rebase,
force-push, or automatic remote delivery.

Commit, push, and PR adapters journal admission before effects. Lost responses use
explicit read-only reconciliation of the existing operation ID; the UI does not
retry an effect automatically. The recovery panel also discovers durable operation
IDs after view/host restart. Unknown results remain unresolved until evidence is
available; a new click is not treated as evidence that the previous effect failed.

Actual child-agent delegation remains disabled. Independent task runtimes and
configured assistant profiles are explicitly distinguished in the UI. Enabling
child-agent execution needs its own authority/budget integration and validation.

## Verification

- `bun run check:assistant`: source and isolated installed-consumer regression.
- `bun test packages/assistant/tests/delivery-*.test.ts`: adapted Desktop adapter
  checks, including stale reviews, protected files, dirty removal, and lost Git/PR
  responses. Remote transports are simulated; no authenticated delivery is claimed.
- `bun test packages/assistant/tests/isolated-tasks.test.ts`: two actual host runtimes,
  separate edits and approvals, capacity, source preservation, and removal guards.
- `bun run packages/assistant/scripts/smoke-tasks.ts`: real local Git and browser UI,
  dropped commit response/reconciliation, blocked removal, and mobile layout.
- `bun run --cwd packages/assistant build:desktop` and `smoke:desktop`: native bundle
  and lifecycle regression. `tasks-fixture.ts` supplies a temporary offline native
  fixture; never replace the production host with that fixture.

The native acceptance used a temporary repository and a temporary copy of the app.
No real push or pull request was created. Windows/Linux, remote credentials, and
real-provider execution are outside this evidence. See the
[stage-5 report](reports/TAURI_STAGE_5_2026-11-13.json).
