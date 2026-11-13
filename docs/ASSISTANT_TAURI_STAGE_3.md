# Assistant Tauri stage 3: review, checks and checkpoint recovery

Implemented locally on 2026-11-13, following [the agent plan](ASSISTANT_TAURI_AGENT_PLAN.md)
and extending [stage 2](ASSISTANT_TAURI_STAGE_2.md). The shared Code composition and
Harness service remain authoritative. Existing local changes were preserved; no reset,
stash, commit, push or publication was performed.

## Review workflow

Open a project conversation and expand **Aprobaciones, cambios y recuperación**. Select
an execution and request its approval review. The view shows full before/after file
contents, visible control characters and concrete commands. It uses Desktop's complete-
content diff fallback, not partial-hunk acceptance. A file-level follow-up button fills
the conversation composer. Sending remains subject to the existing run state; reject or
finish a pending operation before issuing an ordinary follow-up.

Positive approval requires an explicit acknowledgement and a complete supported preview.
The host issues a bounded, five-minute, single-use receipt, bound to conversation,
session, run, revision and approval digests. It reprojects the preview before dispatch;
the engine revalidates revision and filesystem preconditions under mutation admission.
Unsupported, oversized, redacted or unavailable previews cannot authorize execution.
Rejection does not grant effects. The HTTP route accepts the receipt and boolean decision,
not tool arguments, signatures or an arbitrary privileged command.

The trusted adapter is adapted from Desktop's `approval-review`, `review-tickets` and
`checkpoint-review` modules. Its contracts live in the browser-safe application boundary;
no renderer imports host code. Only the host receives the service's `dispatchReviewed`
callback. Ordinary protocol routes continue to reject direct approval/restore dispatch.
Review tickets are consumed before I/O. After a lost response, inspect saved state rather
than automatically replaying a decision. Tickets do not survive host restart.

**Actualizar cambios e historial** reads the engine's decision history, including origin,
channel, status and exact saved applied diffs where the journal certifies them. History is
paged in groups of 25. Generic check output remains historical observation: an exit code
of zero is not a claim about the current workspace or acceptance of a task.

## Checks and explicit task acceptance

The task section starts a **new conversation** with an operator goal, tracked file paths,
package checks and an explicit token budget (100,000 input, 20,000 output, 120,000 total).
It uses Code's existing `task.start`, `task.review`, `task.keep`, `task.revise` and
`task.continue` contracts. The engine currently requires a clean Git baseline, existing
tracked text files and supported local execution. The app never commits, resets or
cleans a project to satisfy those prerequisites. OCI task control remains unsupported
by this existing engine contract and fails closed; it is not silently run locally.

A delivery review shows artifact correspondence, check evidence status, full task diff
and the recorded human decision. Explicit **Aceptar entrega** is separate from tool
execution approval. Checks are bound by the engine to the task contract, command policy,
content identity and tool journal. Later edits make the evidence and acceptance stale;
re-review cannot authorize acceptance of those stale bytes. Correction/continuation uses
the engine's review receipt and preserves the task contract, budget and evidence.

The existing lower command panel shows command, output and exit status; the workspace
header identifies execution mode. Task acceptance provides the stronger content-bound
check status. Ordinary conversational checks are deliberately not promoted to that status.

## Checkpoints and interrupted restores

The checkpoint panel adapts Desktop's existing capture, inspection, restore and recovery
workflow. Capture records current contents for a selected completed turn, not historical
file versions: up to 20 existing UTF-8 files, 64 KiB each. It does not capture arbitrary
binary files, creation/deletion or a complete workspace image.

Preparing restoration reads current file identities and persists an engine proposal.
Confirmation uses a single-use host receipt (15-minute expiry), exact proposal identity
and session revision. The before/after view and acknowledgement precede effects. Changes
made after preparation cause rejection; unrelated later user edits are not overwritten.
The source conversation is preserved and a completed restore exposes a derived
conversation. Saved operations remain inspectable after disconnection/restart.

An interrupted fork may be reconciled with an existing child only when the engine verifies
its parent, checkpoint turn and operation title. Interrupted application can be completed
without new writes when all files already match the checkpoint and the engine rechecks
that state. Missing previews, conflicts, partial application or ambiguous effects remain
unresolved until reviewed; the app never fabricates success or repeats unknown effects.

## Verification

- `bun run check:assistant`: 156 source tests passed; offline smoke and isolated installed
  consumer passed (155 tests, one expected skip for the separate Code checkout).
- HTTP integration: full preview, explicit positive/negative decisions, changed-file
  rejection, duplicate rejection, cross-conversation ticket rejection, actual package
  check output, applied history, restore conflict, restored bytes and derived session.
- Adapted Desktop receipt tests: expiry, fabricated/tampered receipts, unsupported or
  redacted previews, bounded storage, interrupted fork validation, completion-only
  recovery and consumed tickets after uncertain transport.
- A disposable Node process was killed after an actual file write but before journal
  completion. Reopening the shared coding composition retained the file effect,
  projected the decision as unknown, withheld a completed diff and rejected approval
  replay. This fault hook exists only in the test fixture.
- 35 focused engine tests passed for checkpoints, preview/diff evidence, failed/stale
  checks and task acceptance. Another 19 architecture/composition tests passed; root
  and Assistant/web typechecks, architecture boundaries and two Rust tests passed.
- `bun run packages/assistant/scripts/smoke-review.ts`: actual Code CLI starts an
  Assistant-owned run; browser reviews and approves edit/check; Code continues the same
  session; browser restores a checkpoint and opens the derived conversation. It then
  starts a clean-baseline task, approves its check, accepts delivery, changes a file and
  confirms stale evidence with acceptance disabled. Responsive review layout is checked.
- **Actual Tauri release webview on macOS:** displayed the proposed before/after diff,
  accepted an acknowledged edit, reviewed the exact package command, displayed exit 0,
  reviewed a checkpoint's reverse diff and observed the restore reach `completed` with
  the derived-conversation action. A temporary copied app used the production Rust shell,
  built UI and real host with an offline model and temporary repository. It did not use
  or modify the user's provider profile. Native task-acceptance UI was covered by the
  browser smoke; the native manual journey covered effect review and checkpoint restore.

See [the evidence report](reports/TAURI_STAGE_3_2026-11-13.json). Build Assistant before
running the browser smoke. The native fixture entrypoint is `scripts/review-fixture.ts`
with `--native-review`; use a disposable copy of the bundle and supply the checkout path
in `ASSISTANT_REVIEW_CODE_ROOT` for its actual Code CLI invocation.

## Remaining boundaries

No live provider evaluation, signed/notarized release or OCI certification is claimed.
No interactive PTY, hunk-level decisions or automatic reconciliation was added. Stage 4
adds the interactive terminal and persistent task operation. The stage-1 local Harness
candidate remains necessary until compatible engine exports are published and consumer
pins are updated. Existing Desktop dependency issues were not changed by this work.
