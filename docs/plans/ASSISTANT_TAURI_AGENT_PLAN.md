# Tauri agent workspace implementation plan

Status: proposed, 2026-11-13. This document does not implement or certify any feature.

## Outcome and scope

Deliver this journey inside Assistant's Tauri application:

**Open repository → request a change → inspect live activity → review changes → run checks → continue or restore.**

Keep general assistance, web access and the terminal interface. Reuse Code's coding
composition and Desktop's domain behavior rather than creating another independent
engine. macOS is the first acceptance target; other platforms require native validation.

This plan extends [Code-to-Assistant migration](CODE_TO_ASSISTANT_MIGRATION.md) with
Tauri delivery stages. It brings desktop integration into the incremental delivery
without changing that plan's ownership boundaries or requiring immediate Code retirement.
The current [Tauri preview](../assistant/ASSISTANT_DESKTOP.md) and
[Electron Desktop architecture](../reports/DESKTOP_ARCHITECTURE.md) remain baseline references.

## Observed starting point

- Tauri starts a bundled Node host and displays Assistant's React UI over authenticated
  loopback HTTP. Closing the app stops the host. There is no native command bridge today.
- Assistant has persistent conversations, providers, integrations, review and cancellation.
  Its host explicitly disables execution, project context, project memory and subagents.
- The UI refreshes its main state every five seconds. It does not yet present a coding
  workspace with files, command output, structured changes and check evidence.
- Code constructs coding runtimes and has a service-backed terminal client with activity
  replay. That client is a starting point, not complete direct-console feature parity.
- Electron Desktop has project registration, reviewed edits, checkpoint recovery, Git
  delivery and task worktrees. These features are not automatically available in Tauri.
- Existing Assistant local changes must be preserved. Baseline evidence must identify
  the exact tree/artifact tested; prior successful tests do not certify new integration.

## Ownership and reuse map

```text
Tauri native shell       Assistant web UI       Code terminal compatibility
         |                      |                         |
         +---------- Assistant application client --------+
                                |
                   Assistant application host
          projects / conversations / runtime ownership / events
                    |                         |
             general runtime          coding runtime per project
                    +----------- Harness -----------+
                     execution / policy / durable state
```

Tauri owns native window integration and a minimal folder-selection handoff. Node owns
application orchestration. Harness owns execution policy and authoritative run state.
The UI receives bounded projections and never owns approval authority or database writes.

| Existing source | Reuse | Required adaptation |
| --- | --- | --- |
| `packages/code/src/cli/configured-harness.ts` | Coding defaults, models, routing, budgets and project memory | Extract UI-independent composition; keep terminal prompts and rendering in CLI adapters |
| `packages/code/src/cli/service-client-cli.ts` | Command mapping, cancellation and replay behavior | Attach through Assistant project routing; preserve stdin, JSON/JSONL, exit codes and Ctrl-C |
| `packages/assistant/src/client.ts`, `host.ts` | Authenticated engine access, general sessions and lifecycle | Add application contracts, runtime registry and authoritative mutation ordering |
| `desktop/src/projects.ts`, `task-worktrees.ts` | Canonical project identity and managed task lifecycle | Remove Desktop-specific type dependencies; reuse through Assistant-owned services |
| `desktop/src/runtime-host.ts`, `runtime.ts` | Runtime ownership, recovery and reviewed dispatch behavior | Replace Electron utility-process/parent-port transport with a private Node adapter |
| `desktop/src/approval-review.ts`, `review-tickets.ts`, `review-scope.ts`, `checkpoint-review.ts` | Concrete review, expiry, revisions and recovery | Keep trusted validation in host; expose typed application operations |
| `desktop/src/FileDiff.tsx`, `ReviewPanel.tsx`, `CheckpointPanel.tsx`, `DecisionHistory.tsx`, `TaskPanel.tsx` | Review and task presentation | Replace `window.harness` dependencies with client props/hooks and Assistant styling |
| `desktop/src/activity.ts`, `Conversation.tsx` | Activity projections and conversation behavior | Integrate with Assistant's existing conversation components and event cursor |
| `desktop/src/git-delivery.ts`, `remote-delivery.ts`, `pr-delivery.ts` and corresponding panels | Reviewed Git operations and reconciliation | Port after the core journey; preserve uncertain-outcome handling |
| Desktop smoke fixtures and Assistant desktop scripts | Review, restart, worktree and packaged-runtime scenarios | Run against the Tauri/Node adapters; Electron success alone is insufficient |

Extract shared logic behind explicit module contracts. Do not import Electron main or
preload into Assistant, expose a generic shell bridge, or create a new public package
solely for this migration. Keep Harness imports on declared public entrypoints.

## Stage 0 — Baseline and contracts

**Deliverables**

- Inventory each required journey operation as available, adaptable or new, with its
  owning module and fixture. Record terminal compatibility separately from GUI delivery.
- Define application contracts for projects, conversation/runtime references, capability
  discovery, activity attachment, review and recovery. Reuse engine command/event types.
- Define initial capabilities: general assistance, project coding and isolated task coding.
  Distinguish effect authorization from final acceptance of changes.
- Record baseline Assistant, Code and Desktop checks. Add architecture checks preventing
  renderer imports of privileged code and Assistant imports of Electron implementation.

**Acceptance:** contracts cover every step of the target journey; the baseline identifies
existing failures separately from migration regressions. No runtime behavior changes.

## Stage 1 — Project host and coding runtime

**Depends on:** stage 0.

**Deliverables**

- Add an Assistant-owned project registry with canonical paths, stable IDs and exclusive
  runtime/store ownership. Keep general sessions bound to their current private workspace.
- Extract Code's coding composition and run it under the Assistant host. Initially allow
  one active mutation per project; separate projects have separate execution scopes.
- Bind conversations durably to a project/runtime. Moving a conversation to a different
  execution scope creates a new binding rather than rewriting prior history.
- Extend the application client and service terminal route so one coding session can be
  opened, edited, checked and inspected without the new desktop panels.
- Select an explicit supported execution backend and expose missing prerequisites.
  Never silently fall back from isolated execution to unrestricted host commands.
- Enforce mutation ordering, cancellation and revision checks in the authoritative host.
  Client-side promise queues do not provide cross-client locking.

**Acceptance:** general assistance plus two registered projects operate without context,
tool or approval leakage; a fixture edits and checks a project through the terminal.
Duplicate ownership and stale mutations fail explicitly. Existing general history works.

**Rollback:** disable new coding registration and release its runtimes; preserve stores.
Do not hand an active or uncertain operation to a second owner.

## Stage 2 — Tauri workspace and live activity

**Depends on:** stage 1.

**Deliverables**

- Add a native folder chooser with a narrowly scoped trusted registration handoff.
  Register the chosen canonical path in the host; normal UI commands use project IDs.
  Retain origin, token and navigation checks; do not grant arbitrary native shell access.
- Add project/conversation navigation, central chat, a resizable file/change panel and a
  lower command-output panel. Keep the general-assistance view available.
- Add bounded, project-scoped file reads, explicit context attachments and file/line links.
  Show model and execution capabilities for the selected conversation.
- Replace coarse chat refresh with cursor-based activity delivery, using an HTTP event
  stream or bounded long polling. Recover from snapshot plus cursor after disconnection.
- Show tool activity, output, errors and cancellation without blocking navigation to
  another conversation. Scope asynchronous updates to their original project/session.

**Acceptance:** choose a repository in the native app, submit a coding request, observe
tools and output, cancel, switch sessions and reload without losing or duplicating events.
An expired cursor rebuilds the view. Smoke evidence includes the actual Tauri webview.

**Rollback:** hide the coding workspace; existing general UI and service terminal remain.

## Stage 3 — Review, checks and checkpoint recovery

**Depends on:** stage 2. This stage completes the first end-to-end milestone.

**Deliverables**

- Adapt Desktop's diff, approval, decision-history and checkpoint presentation. Show the
  concrete affected files, commands and effects instead of raw review JSON.
- Keep single-use, expiring review receipts tied to project/session/run/revision in the
  trusted host. Revalidate before mutation; reject stale or incomplete previews.
- Support follow-up instructions referring to a file/change. Start with file-level
  feedback; defer partial-hunk acceptance until the engine can enforce its semantics.
- Present configured checks with command, execution environment, exit status and output.
  Bind evidence to the relevant workspace revision/content identity; mark results stale
  after subsequent edits. A generic successful check is not proof of the reviewed bytes.
- Show the changes produced and support explicit acceptance/continuation. Authorization
  to execute an edit is separate from acceptance of the finished task.
- Expose checkpoint inspection and reviewed restoration, including conflicts with later
  user edits. Preserve recovery evidence and never silently overwrite unrelated changes.

**Acceptance fixture:** open a small repository, request an edit, approve where required,
inspect the diff, run a passing check, request a follow-up, then restore a checkpoint.
Also cover rejected approval, failing check, stale file, expired review, duplicate decision,
disconnect after a mutation and process failure between an effect and journal completion.
Ambiguous outcomes stay unresolved until reconciled; they are not automatically replayed.

**Cross-interface gate:** start in terminal, review in Tauri, continue in terminal, and
observe the same authoritative state through the web UI.

**Rollback:** stop new coding mutations if review/recovery fails; retain read access and
the compatible terminal recovery path. Do not downgrade a changed store blindly.

## Stage 4 — Interactive terminal and persistent task operation

**Depends on:** stage 3.

- Add a real PTY-backed terminal with resize, input, interruption and process cleanup.
  Stage 2's command-output panel is not an interactive terminal. Choose the PTY dependency
  after checking native bundle compatibility; validate packaged macOS behavior.
- Separate user-typed shell activity from agent-issued commands. A user terminal does
  not grant the agent additional execution permissions. External edits invalidate reviews
  and check evidence where appropriate.
- Add explicit task states and an attention queue; keep the UI responsive during work.
- Implement and document close-window versus quit semantics. A hidden/tray host may keep
  tasks running, but explicit quit must offer controlled drain/cancel handling.
- Restore views and reconcile interrupted work on restart. Continue pending approvals
  only under compatible bindings; do not promise automatic crash resumption.
- Add completion/attention notifications with user-controlled OS permissions.

**Acceptance:** a task continues while its window is closed under the chosen background
policy; reopening recovers its activity. Explicit quit and crash produce truthful states.
PTY exit leaves no orphan processes, and cancellation remains available during long work.

## Stage 5 — Isolated concurrent tasks and Git delivery

**Depends on:** stage 4.

- Adapt managed worktrees and task panels, with bounded concurrency and per-task budgets.
  Initial worktrees use committed HEAD; disclose excluded uncommitted source changes.
- Add safe task removal using a fresh dirty-file, integration and lock inspection.
- Port reviewed commit, push and pull-request flows with journals and reconciliation.
  Review the actual destination and content before remote effects.
- Add delegation only after isolated task ownership is proven. Distinguish configured
  assistant profiles, concurrent sessions and actual child-agent execution in the UI.

**Acceptance:** two tasks run in separate worktrees without crossing files or approvals;
dirty tasks cannot be silently removed. Lost Git responses reconcile without duplicate
delivery. Real authenticated delivery requires separate evidence from offline fixtures.

## Stage 6 — Preview, browser verification and artifacts

**Depends on:** stage 3; may ship independently of stage 5 after the core milestone.

- Add supervised development-server processes and previews with explicit port/origin
  ownership. Keep arbitrary preview content isolated from the privileged application UI.
- Introduce a bounded browser-control capability for the agent, scoped to the task and
  separately authorized where needed. Do not assume an existing browser agent is reusable.
- Persist plans, screenshots and verification summaries as task artifacts with provenance,
  timestamps and links to the tested revision. Support feedback anchored to artifacts.
- Clean up browsers/servers when tasks end and make failed visual checks visible.

**Acceptance:** a fixture changes a local UI, starts its server, performs a browser check,
captures evidence and presents a reviewable result. Stale evidence is clearly identified;
preview content cannot call privileged host operations.

Implementation: [stage 6](../reports/ASSISTANT_TAURI_IMPLEMENTATION.md#stage-6) provides supervised immutable
static-output servers, separately approved browser checks and persistent evidence.
Framework dev-server/HMR attachment and automatic Chromium provisioning remain outside
this bounded implementation. Existing runtime tool bindings are preserved.

## Stage 7 — Packaged pilot and gradual cutover

**Depends on:** stage 4 for the core pilot; stages 5–6 for their advertised features.

- Validate the installed Tauri bundle outside the source checkout: bundled runtime,
  keychain, project tools, review, terminal, recovery and shutdown.
- Document Git, execution-backend and provider prerequisites with actionable setup errors.
- Provide migration preflight for Code/Desktop state and credential references. Adopt only
  compatible stores, back up before conversion and preserve incompatible history. Finish
  or reconcile active work under its original owner before transfer.
- Preserve the Code command as a compatibility path until the migration parity matrix
  passes. Do not port the Electron updater directly: validate Tauri packaging, signing,
  notarization, update trust and rollback separately before production distribution.
- Keep Windows/Linux unsupported until their native permissions, PTY, keychain, lifecycle
  and package checks pass. Document supported architectures explicitly.

**Acceptance:** a fresh installed pilot and an upgrade/recovery fixture pass on supported
macOS targets. Complete a real-provider coding journey and label any unverified external
integration. Retire duplicate composition only after compatibility and recovery gates pass.

Implementation and remaining acceptance gates: [stage-7 local pilot](../assistant/ASSISTANT_TAURI_STAGE_7.md).
The implementation preserves Code/Desktop. The authorized real-provider coding fixture has
passed; production cutover remains blocked on signing, notarization, update-trust and
cross-version rollback evidence.

## Delivery order and evidence

Implement stages 0–3 first. Their acceptance journey is the first usable coding milestone.
Stage 4 makes sustained desktop work practical; stages 5 and 6 add parallel supervision
and visual verification. Stage 7 turns the accepted scope into a distributable product.

Suggested reviewable change sequence:

1. Baseline inventory and client contracts.
2. Coding composition extraction, leaving Code behavior intact.
3. Project registry, runtime ownership and terminal attachment.
4. Native folder handoff and workspace navigation.
5. Event replay, activity UI and scoped file inspection.
6. Concrete edit review and check evidence.
7. Checkpoint restoration and the complete journey fixture.
8. PTY and explicit background/quit lifecycle.
9. Worktrees and Git delivery, split by operation.
10. Browser capability and task artifacts.
11. Installed pilot, migration and release readiness for the chosen feature set.

Each implementation change records affected boundaries, targeted checks, fixture evidence
and rollback behavior. Run broader regression suites when shared contracts change; use
native Tauri verification for shell/webview behavior rather than relying only on a browser.
Keep simulated execution, real provider calls, real browser checks and signed distribution
evidence distinct. Calendar estimates should follow stage 0's inventory and dependency
assessment; acceptance gates determine readiness.

Stage 4 implementation details and validation limits:
[Interactive terminal and persistent operation](../reports/ASSISTANT_TAURI_IMPLEMENTATION.md#stage-4).

Stage 5 task isolation and delivery implementation:
[Managed tasks and reviewed Git delivery](../reports/ASSISTANT_TAURI_IMPLEMENTATION.md#stage-5).
Child-agent delegation remains explicitly disabled; offline remote-delivery fixtures
are separate from authenticated push/PR evidence, which has not been collected.
