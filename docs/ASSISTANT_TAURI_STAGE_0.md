# Tauri agent workspace: stage 0 baseline and application boundary

Date: 2026-11-13. Implements stage 0 of the
[workspace plan](ASSISTANT_TAURI_AGENT_PLAN.md). No coding runtime, native permissions,
transport routes or UI behavior are enabled by this stage.

## Implementation

- `packages/assistant/src/application-contracts.ts` defines the proposed application
  client, immutable conversation bindings, capability discovery, project selection,
  engine command dispatch, activity attachment and reviewed recovery.
- This is a source-level, browser-safe contract module, not a published package subpath
  or an implemented client. Existing `connectAssistant` and host exports are unchanged.
  Stage 1 must implement validation, version negotiation, routing and ownership before
  consumers can use it. Publishing a client-safe package entrypoint is a separate change.
- `scripts/check-architecture.ts` now visits Code and Assistant's renderer in addition
  to the existing roots. It rejects privileged renderer dependencies, Electron imports
  from Assistant and Code, and host dependencies hidden in the contract module.
- `tests/architecture.test.ts` covers import/re-export/dynamic/type-only violations and
  browser bundling. Assistant's contract test contains compile-time negative cases for
  arbitrary path selection, missing bindings, project overrides and unreviewed effects.
- Existing architecture CI invokes this checker; no additional pipeline is necessary
  for these rules. The existing Assistant typecheck includes the contract assertions.

## Journey inventory

Status describes the target Tauri journey, not whether equivalent code exists elsewhere.
**Adapt** means reuse with application/transport changes; **new** means missing product
behavior. Evidence sources below are reusable fixtures, not claims of Tauri certification.

| Operation | Status | Existing owner and reuse source | Delivery owner/stage | Evidence to adapt or add |
| --- | --- | --- | --- | --- |
| Open repository | Adapt + new native handoff | `desktop/src/projects.ts`, `desktop/src/main.ts` | Assistant registry / Tauri selector, 1–2 | `desktop/tests/projects.test.ts`; new selector-token and scope fixtures |
| Bind conversation to project | Adapt | `desktop/src/bridge.ts`, `packages/assistant/src/client.ts` | Application host, 1 | `packages/assistant/tests/host.test.ts`; new two-project and duplicate-owner fixtures |
| Configure coding runtime | Adapt | `packages/code/src/cli/configured-harness.ts` | Assistant coding factory, 1 | `packages/code/tests/node-engine.test.ts`; general-versus-coding isolation fixture |
| Submit change request | Adapt | `packages/code/src/cli/service-client-cli.ts`, Harness `run.start` / `task.start` | Application host/client, 1–2 | `tests/service-client-cli.test.ts`, `tests/task-transport.test.ts` |
| Read files and attach context | Adapt + new UI | Code coding runtime / Harness project tools | Scoped host reads and workspace panel, 2 | New canonical-path, out-of-scope and context-attachment fixtures |
| Observe tool and response activity | Adapt | `desktop/src/activity.ts`, `packages/assistant/src/client.ts`, engine activity pages | Application events + React, 2 | `desktop/tests/activity.test.ts`, `tests/service-events.test.ts` |
| Cancel while provider is active | Available in Assistant; adapt scope | `packages/assistant/src/host.ts`, existing web cancel route | Application routing, 1–2 | `packages/assistant/tests/host.test.ts`, `tests/task-cancellation-transport.test.ts` |
| Reload/reconnect with expired cursor | Adapt | Engine snapshots/cursors, Code service client | Application attachment, 2 | `tests/service-events-capacity.test.ts`, `tests/local-service-recovery.test.ts` |
| Review an edit or command before execution | Adapt | `desktop/src/approval-review.ts`, `review-tickets.ts`, `ReviewPanel.tsx` | Trusted review host + React, 3 | `desktop/tests/approval-review.test.ts`, `desktop/tests/review-tickets.test.ts` |
| Inspect completed changes and request revisions | Adapt | `desktop/src/FileDiff.tsx`, `packages/web/src/TaskPanel.tsx`, Harness task review | Application client + React, 3 | `tests/task-acceptance-delivery.test.ts`, `tests/task-acceptance-record.test.ts` |
| Run checks and show evidence | Adapt + new UI | Harness task acceptance/checks and Code task flow | Coding host + results panel, 3 | `tests/task-acceptance-checks.test.ts`; new changed-bytes invalidation fixture |
| Accept changes and continue | Adapt | Harness `task.keep`, `task.revise`, `task.continue` | Application command routing, 3 | `tests/task-continuity.test.ts`, `tests/task-control.test.ts` |
| Inspect/capture checkpoints | Adapt | Harness checkpoint commands and `desktop/src/CheckpointPanel.tsx` | Application client + React, 3 | `tests/client-checkpoints.test.ts`, `tests/workspace-checkpoints.test.ts` |
| Restore/recover without overwriting later edits | Adapt | `desktop/src/checkpoint-review.ts`, Harness restore commands | Trusted review host, 3 | `desktop/tests/checkpoint-review.test.ts`, `desktop/src/smoke-checkpoints-verification.ts` |
| Handle uncertain effects after crash | Adapt | Harness journals and Desktop recovery | Host lifecycle, 1–3 | `desktop/src/smoke-effect-crash-verification.ts`; cross-interface lost-response fixture |
| Interactive terminal | New Tauri integration | Code console remains a separate supported interface | PTY service + panel, 4 | New packaged PTY resize, input, interrupt and cleanup fixtures |
| Background work and notifications | New | Current Tauri host stops on app exit | Native lifecycle + host, 4 | New close/reopen/quit and permission fixtures |
| Isolated concurrent tasks | Adapt | `desktop/src/task-worktrees.ts`, `TaskPanel.tsx` | Task registry, 5 | `desktop/tests/task-worktrees.test.ts`, `desktop/src/smoke-worktrees-verification.ts` |
| Commit/push/PR | Adapt | Desktop Git delivery services and panels | Host review/delivery, 5 | `desktop/tests/git-delivery.test.ts`, `remote-delivery.test.ts`, `pr-delivery.test.ts` |
| Browser and visual artifacts | New product capability | No browser-agent integration established by this baseline | Browser adapter/artifact host, 6 | New isolated preview, visual evidence and cleanup fixtures |
| Installed Tauri journey | Adapt + new full fixture | `packages/assistant/scripts/smoke-desktop.ts` | Packaging and native verification, 7 | Existing lifecycle smoke plus complete native coding journey |

## Terminal compatibility classification

The terminal remains a first-class interface. GUI delivery does not retire Code.

| Terminal behavior | Classification | Source / required evidence |
| --- | --- | --- |
| Session list/create/read, run, cancel, approvals | Required for first coding milestone | `packages/code/src/cli/service-client-cli.ts`; cross-client scope and review checks |
| Task review, keep/revise/continue, checkpoints and restore | Required by stage 3 | Same client and engine protocol; terminal→Tauri→terminal journey fixture |
| stdin, JSON/JSONL, exit codes, Ctrl-C | Preserve for every migrated command | Service client, `packages/code/tests/cli-options.test.ts`, `tests/service-client-cli.test.ts` |
| Routing, budgets, compaction, project instructions/memory | Preserve existing Code behavior; later full application parity | `configured-harness.ts`, console helpers; no silent default changes during extraction |
| Subagent configuration and execution | Retain Code path; application integration at stage 5 or parity cutover | Code routing/profile composition; do not interpret multiple named assistants as delegation |
| Audit, state administration and provider administration | Retain advanced Code command path until migration matrix is proven | Code CLI/options and audit fixtures; no new GUI requirement for stage 3 |
| Shell terminal embedded in the app | New stage 4 work | Not equivalent to Code's conversational terminal or an output-only panel |

## Contract semantics

### Identity and routing

An `AssistantConversationBinding` contains an application conversation ID, runtime ID,
engine project/session IDs and a discriminated execution context. General contexts have
no repository, project contexts require a registered project key, and isolated tasks
also require a task ID. A context change creates a new binding. Session/run IDs in an
engine command must belong to that binding; the host must reject mismatches.

Project paths are display metadata. Registration consumes a one-use selection token
issued through a trusted native or terminal selector, which stage 1 must implement.
A token is not secure merely because it is typed as a string. The host must verify
issuer, ownership, expiry and canonical path before consuming it.

### Capabilities

All capability keys have an explicit availability state; unavailable keys carry a
reason. General, project and isolated-task contexts are identities, not implicit grants.
For example, a coding project may have file access while command execution is unavailable
because the configured backend is missing. The current general host is not modified
or made to advertise any of the proposed capabilities by stage 0.

### Commands and concrete review

`AssistantApplicationEngineCommand` reuses the engine command union, removing caller-
supplied `projectId` and the privileged `approval.resolve`, `restore.apply` and
`restore.recoverFork` variants. Preserve engine revisions, idempotency keys, task review
IDs and error responses; do not invent a second run/checkpoint model.

Effect/restore review uses a host-issued receipt and `decide`. The host must retain
and revalidate scope, content, revision, expiry and single-use state. The receipt's engine
response is a provisional preview carrier, not permission to approve an unsuccessful,
redacted or incomplete review. Concrete presentation is implemented in stage 3.

Final acceptance is separate: `task.keep`, `task.revise` and `task.continue` remain engine
commands with engine-issued review IDs. Accepting completed work does not authorize a
future edit, shell command or remote Git effect.

The outer application result represents routing, capability and transport failures;
its nested engine response preserves engine success/conflict semantics. A successful
outer result must not cause the UI to ignore a failed engine response.

### Attachment, ordering and recovery

`attach` preserves the engine's activity page, cursor-expiration flag, snapshot and
evidence-completeness fields. On expiration, rebuild from the returned snapshot and
remaining events using engine semantics. This boundary does not promise an SSE transport.

Mutations are serialized by the authoritative host per runtime/project. Cancellation
and reads remain available during provider work. After a lost response, inspect current
state before retrying. No cross-connection exactly-once promise is introduced here.
Recovery is explicit inspection, reviewed restore or reviewed restore-fork recovery;
there is no automatic replay/resume method in the application contract.

## Architecture coverage and limits

The checker scans all TypeScript/TSX sources in `src`, `desktop/src`,
`packages/code/src`, `packages/assistant/src` and `packages/assistant/web/src`.
Assistant renderer modules may reference local view modules, the application contract
and an explicit list of current browser libraries. Local helpers are scanned too;
the contract permits only type imports from the public engine protocol. New browser
dependencies require an intentional rule update and browser validation.

These are static source-import checks, not a security sandbox or an audit of external
package internals. They do not newly certify Electron's renderer or prevent runtime
`eval` abuse. Existing engine dependency-closure checks are retained.

Code is now traversed, but full Code-to-engine boundary cleanup is deferred: for example,
`packages/code/src/cli/console/review-diff.ts` still imports
`src/review/reveal-invisible.ts` directly. Stage 0 records this extraction debt rather than
silently changing Code behavior. Public application integration must use a future
explicit client-safe entrypoint, not the current host-exporting Assistant root.

## Baseline and readiness

The machine-readable [stage 0 evidence](reports/TAURI_STAGE_0_2026-11-13.json) records
the HEAD, initial modified/untracked file hashes, commands, outcomes and log hashes.
Source identification is HEAD plus those initial file contents, not HEAD alone. Local
logs live under `/tmp/tauri-stage0`; they are diagnostic files, not portable release evidence.

- Baseline architecture: 13 passing tests.
- Code: typecheck and 170 tests pass.
- Assistant: initial sandbox run has 84 passes and 46 failures, including denied local
  socket binds. Re-running the existing `check:assistant` outside the sandbox passes
  130 tests, offline smoke and installed-candidate checks. The installed candidate hash
  is recorded in the evidence; this does not certify real provider/OAuth calls.
- Desktop: baseline typecheck fails with mismatched installed candidate/core types and
  missing provider exports. Its linked candidate directory is
  `28d04150b4cec95a25f1330de82ee42fd2fe06c2f05763480ad5ad5bd7f1cb2a`.
  Test outcomes and the socket-enabled rerun are recorded separately in the evidence.
  Do not refresh that candidate as an incidental stage 0 change.
- New boundaries and source contracts pass architecture checks, root and Assistant
  typechecks, browser contract bundling and contract assertions.
- Native Tauri UI, signed distribution, live provider calls and the future coding journey
  were not tested in stage 0. These require their stage-specific implementations.

Stage 0's deliverables are implemented. The baseline is explicitly not all green:
Desktop dependency/candidate reconciliation is a prerequisite for claiming Desktop
regression parity during extraction. Stage 1 may proceed with that issue tracked, while
keeping all original local source changes intact.
