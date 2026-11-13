# Tauri implementation history: stages 0–6

Consolidated implementation snapshots from 2026-11-13. Each stage retains its
original behavior, validation results and limitations; later stages may supersede
earlier statements. These are not new certification results. For current entrypoints,
see the [native guide](../assistant/ASSISTANT_DESKTOP.md) and
[pilot runbook](../assistant/ASSISTANT_TAURI_STAGE_7.md).

- [Stage 0](#stage-0)
- [Stage 1](#stage-1)
- [Stage 2](#stage-2)
- [Stage 3](#stage-3)
- [Stage 4](#stage-4)
- [Stage 5](#stage-5)
- [Stage 6](#stage-6)

<a id="stage-0"></a>

## Tauri agent workspace: stage 0 baseline and application boundary

Date: 2026-11-13. Implements stage 0 of the
[workspace plan](../plans/ASSISTANT_TAURI_AGENT_PLAN.md). No coding runtime, native permissions,
transport routes or UI behavior are enabled by this stage.

<a id="stage-0-implementation"></a>

### Implementation

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

<a id="stage-0-journey-inventory"></a>

### Journey inventory

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

<a id="stage-0-terminal-compatibility-classification"></a>

### Terminal compatibility classification

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

<a id="stage-0-contract-semantics"></a>

### Contract semantics

<a id="stage-0-identity-and-routing"></a>

#### Identity and routing

An `AssistantConversationBinding` contains an application conversation ID, runtime ID,
engine project/session IDs and a discriminated execution context. General contexts have
no repository, project contexts require a registered project key, and isolated tasks
also require a task ID. A context change creates a new binding. Session/run IDs in an
engine command must belong to that binding; the host must reject mismatches.

Project paths are display metadata. Registration consumes a one-use selection token
issued through a trusted native or terminal selector, which stage 1 must implement.
A token is not secure merely because it is typed as a string. The host must verify
issuer, ownership, expiry and canonical path before consuming it.

<a id="stage-0-capabilities"></a>

#### Capabilities

All capability keys have an explicit availability state; unavailable keys carry a
reason. General, project and isolated-task contexts are identities, not implicit grants.
For example, a coding project may have file access while command execution is unavailable
because the configured backend is missing. The current general host is not modified
or made to advertise any of the proposed capabilities by stage 0.

<a id="stage-0-commands-and-concrete-review"></a>

#### Commands and concrete review

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

<a id="stage-0-attachment-ordering-and-recovery"></a>

#### Attachment, ordering and recovery

`attach` preserves the engine's activity page, cursor-expiration flag, snapshot and
evidence-completeness fields. On expiration, rebuild from the returned snapshot and
remaining events using engine semantics. This boundary does not promise an SSE transport.

Mutations are serialized by the authoritative host per runtime/project. Cancellation
and reads remain available during provider work. After a lost response, inspect current
state before retrying. No cross-connection exactly-once promise is introduced here.
Recovery is explicit inspection, reviewed restore or reviewed restore-fork recovery;
there is no automatic replay/resume method in the application contract.

<a id="stage-0-architecture-coverage-and-limits"></a>

### Architecture coverage and limits

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

<a id="stage-0-baseline-and-readiness"></a>

### Baseline and readiness

The machine-readable [stage 0 evidence](TAURI_STAGE_0_2026-11-13.json) records
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

<a id="stage-1"></a>

## Tauri agent workspace: stage 1 project host

Implemented 2026-11-13 against the local Harness candidate. This delivers stage 1 of
the [workspace plan](../plans/ASSISTANT_TAURI_AGENT_PLAN.md): a general Assistant host plus
project-bound coding runtimes, with Code's terminal attached to those runtimes.
The Tauri folder picker, workspace panels and event UI remain stage 2.

<a id="stage-1-shared-composition"></a>

### Shared composition

`src/runtime/coding-composition.ts` exposes the experimental `createCodingHarness`
and `CreateCodingHarnessOptions` through `@zhivex-ai/harness/engine`. The public API
inventory records the new exports.

Code's `createConfiguredHarness` now calls that shared constructor. It retains its
credential prompts, provider/route preparation, compaction model, telemetry observer
and CLI error handling. The shared part owns curated project-memory defaults, bounded
pricing-file loading, monetary-policy conflict detection and final engine composition.
Assistant calls the same constructor with host-owned workspace, state and scope.
No imports from Code or Electron implementation were introduced in Assistant.

The general runtime still uses `createProfiledHarness` with its existing private
workspace and disabled project context/execution. Coding is opt-in and is never
enabled by Telegram, model output or an ordinary web request.

<a id="stage-1-host-and-application-client"></a>

### Host and application client

`startAssistantHost({ coding: ... })` returns an `application` handle with:

- `client`: the stage-0 application interface implemented in process. It validates
  project selection, conversation creation, scoped commands and activity attachment.
- `selectProject(path)`: trusted local bootstrap only. It resolves Git's canonical
  repository root and issues a one-use selection token valid for 60 seconds.
- `projectConnection(projectKey)`: starts/attaches the project's runtime and returns
  the private service credentials path for the existing Code service CLI.
- `close()`: closes project services, drains their accepted operations and releases
  project ownership. The enclosing host invokes this during its own shutdown.

There is no new public HTTP/IPC endpoint in this stage. The versioned client is an
in-process contract; a future transport must negotiate versions and retain these checks.
The terminal already negotiates the engine's authenticated local service protocol.

The application routes by immutable conversation binding, not renderer-supplied paths
or engine project IDs. It rejects cross-session commands and raw privileged approval
or restore commands. It reuses engine revisions, task review IDs, idempotency keys,
activity pages and snapshots. Existing general and terminal-created sessions can be
discovered through `client.conversations()` without rewriting their engine history.

Application `review` and `decide` return `CAPABILITY_UNAVAILABLE` until stage 3 adds
concrete review receipts and presentation. Effect approval is available through the
existing Code terminal review flow. The application advertises its own capabilities,
not every capability of that compatibility terminal; tool availability is derived from
the constructed coding runtime. Capability availability never overrides engine policy.

<a id="stage-1-state-identity-and-ownership"></a>

### State, identity and ownership

| Location | Responsibility |
| --- | --- |
| `<assistant directory>/projects/projects.json` | Private canonical project catalog and immutable conversation references |
| `<repository>/.zhivex-harness/assistant-owner.json` | Exclusive project ownership across Assistant instances |
| `<repository>/.zhivex-harness/assistant-owner.json.claim` | Short-lived exclusive ownership/recovery transaction |
| `<repository>/.zhivex-harness/assistant/` | New coding SQLite state and runtime configuration binding |
| `<assistant directory>/transport/` | Authenticated engine service sockets and owner-private connection files |

Canonical project IDs follow Desktop's SHA-256 path identity convention. Selection
through a symlink or a subdirectory resolves to the same Git root. Index writes use
bounded private files, atomic rename and directory sync. Neither UI nor terminal
registration duplicates engine run/checkpoint persistence.

The project lock is acquired before constructing its engine or opening its databases.
Recovery checks that the previous PID is gone; it never steals a live owner. A crash
during the short `.claim` transaction fails closed and requires inspection rather than
blind deletion. Locks coordinate Assistant hosts. They do not prevent a user or an
unrelated legacy Code/Desktop process from independently editing the same checkout.
Keep those legacy writers stopped while testing this opt-in project host.

The runtime binding includes engine configuration/scope, model identity, memory mode,
tool selection/policy and usage settings, plus an operator-supplied `configurationId`.
The supplied ID must change when injected adapters, callbacks or the contents of
operator-owned policy/pricing files change. Provider connection identity is incorporated
when the general provider is inherited. A mismatched binding is rejected; automatic
state/configuration migration is not implemented here.

Project storage is separate from legacy Code/Desktop stores. Existing stores are not
adopted or converted. Moving a repository or changing its execution identity therefore
requires a later explicit migration/new-binding workflow, not editing fingerprints.

<a id="stage-1-execution-and-concurrency"></a>

### Execution and concurrency

Choose an explicit mode:

- `local`: the existing Code workspace tools edit repository files and run reviewed,
  allowlisted package scripts on the host. This maps to Harness backend `none`; it is
  not a container or a general-purpose interactive shell.
- `oci`: Harness must initialize the configured OCI runtime/image. Failure reports
  `EXECUTION_UNAVAILABLE`; there is no local fallback. The runtime/image must already
  satisfy Harness's execution requirements.

Only trusted host configuration can set execution, models, allowed checks or budgets.
The stage-1 coding API excludes custom shared stores/memory/MCP clients, and delegation
is disabled. Projects use separate scopes and runtime instances. The default cap is
eight open projects (configurable from one to 32); reaching it returns `RUNTIME_BUSY`.
There is no idle eviction yet, and a project service remains owned until host shutdown.

The authoritative engine service admits one mutation per runtime. Concurrent clients
receive `BUSY` or revision conflicts; reads and cancellation stay available. Assistant's
application adapter disables its optional client-local promise queue and relies on
this shared service boundary. Uncertain responses require state inspection, not blind
retry. Idempotency retains the engine's connection-scoped semantics.

Closing the application still stops its host. Background/tray operation is stage 4.
Crash recovery preserves history and pending approvals without automatically replaying
edits or resuming model work.

<a id="stage-1-try-from-the-checkout"></a>

### Try from the checkout

Build and prepare the matching local engine candidate first:

```sh
bun run build
bun run --cwd packages/assistant prepare:local
bun run --cwd packages/assistant build
```

Start the foreground host with an explicit repository and execution choice. Configure
provider credentials using the existing supported environment or configuration path.
Replace the example repository and model ID with your own values:

```sh
node packages/assistant/dist/cli.js \
  --directory "$HOME/.zhx-coding-preview" --owner local \
  --provider openai --model MODEL_ID \
  --project /absolute/path/to/repository --coding-execution local
```

Repeat `--project` for another repository (up to eight at CLI startup). Each
`assistant-project-ready` record gives its `credentialsPath`; it contains no bearer
token. In a second terminal, use that path with the existing Code command:

```sh
bun packages/code/src/cli.ts chat --service /absolute/path/from/ready-record.json
```

The Code service interface supports its existing run/resume/session/chat operations,
streaming, approvals and terminal controls. This does not claim full parity with all
direct Code administrative commands. After an actual unclean stop, restart with
`--recover` and inspect durable state. Do not use recovery to bypass a live owner.

For an embedding application, pass `coding: { execution: "local", configurationId:
"my-coding-config-v1" }` to `startAssistantHost`; provider/model settings inherit from
the general host unless overridden through `coding.engine`.

<a id="stage-1-verification-and-limits"></a>

### Verification and limits

The new integration fixtures verify:

1. General assistance plus two project bindings, alias deduplication, scoped commands,
   stale-revision rejection and persistent identities after restart.
2. One-use selection tokens, bounded runtime admission and unsupported isolated tasks.
3. The actual Code terminal connecting to an Assistant-owned project, proposing and
   applying an approved edit, then running a real passing package script. Another
   repository remains unchanged and the general scope cannot read that run.
4. Refusal to adopt existing project history under a changed configuration.
5. Simulated OCI initialization failure without local fallback.
6. Concurrent independent clients: mutation rejection, live reads and cancellation.
7. Actual Node process termination and explicit recovery, retaining the exact pending
   approval without applying the edit again.

Shared-composition tests verify the inherited project-memory default, explicit opt-out
and rejection of unsafe/malformed pricing files. Architecture tests retain browser and
engine boundaries. Code's existing typecheck and 170 regression tests pass.

The full Assistant check passed 138 source tests plus offline smoke and installed-
candidate validation. The installed consumer passed 137 tests and skipped the single
cross-product Code terminal test because standalone Assistant does not contain Code;
that journey passed separately in the checkout. Post-review targeted tests and exact
artifact evidence are recorded in [the stage-1 report](TAURI_STAGE_1_2026-11-13.json).

This is offline/mock-provider evidence plus real local filesystem, Git, process and
package-check execution. No live provider, real OCI container, Tauri workspace UI or
signed distribution is certified. Desktop's pre-existing dependency/backup failures
from stage 0 were not changed or rerun as part of this implementation.

The new engine exports are available in the local candidate only. Publish a compatible
Harness release and update consumer pins before distributing Code or Assistant against
registry dependencies; the existing `1.6.3` pin does not establish published availability
of these new exports. No publication, migration or commit was performed here.

<a id="stage-2"></a>

## Assistant Tauri stage 2: project workspace and live activity

Implemented locally on 2026-11-13, following [the staged plan](../plans/ASSISTANT_TAURI_AGENT_PLAN.md).
Stage 1's shared Code composition remains the authoritative coding runtime. The general
Assistant view and service terminal remain available. No existing local changes were reset.

<a id="stage-2-workspace-journey"></a>

### Workspace journey

Configure a model in the native app, open **Proyectos**, and use **Abrir carpeta** to
choose a Git repository. The macOS native dialog hands its selection to the host over
its private parent pipe. The authenticated browser request contains no filesystem root.
The host canonicalizes and registers the selection using the stage-1 one-use token.
Other platforms expose already registered projects but do not offer a native chooser yet.

Select a project, open a file, attach its displayed lines, and submit a message. Project
conversations retain immutable runtime bindings. The resizable file panel uses Harness's
safe workspace reader (100 files per page, up to 1,000 displayed; 120 lines per read).
Attachments carry path, digest and line range; the host rereads them and rejects changed
bytes before starting a run. At most four attachments and 60,000 assembled prompt
characters are accepted. File/line links open the same scoped reader. Attached content
is shown as file references in chat rather than exposing the internal prompt envelope.

The central conversation displays incremental text and tool states. The lower resizable
panel shows tool activity and bounded output from `run_check` and
`run_environment_command`, including exit codes. Outputs are limited to the most recent
run's eight command receipts, with 4,000 characters per output stream. It is not a PTY.
Known provider credentials and the core redaction policy apply before output truncation.
The header shows the configured model and explicit local/OCI execution mode.

Navigation remains available while a run is active. **Detener** routes cancellation to
the owning run with its current revision. Browser reload restores the selected binding;
activity replay deduplicates by cursor and event identity. Expired cursors rebuild from
an engine snapshot. Pending drafts stay scoped to their conversation while this view is
mounted; drafts are not persisted across reloads. Use **Actualizar proyectos** to discover
conversations created from the connected terminal.

<a id="stage-2-transport-and-authority"></a>

### Transport and authority

- Workspace HTTP routes retain bearer authentication, Origin validation and admission
  limits. The webview receives no native shell capability or generic protocol dispatcher.
- Activity uses bounded five-second long polling, released on shutdown and aborted on
  navigation. It adapts Desktop's activity reducer without importing Desktop internals.
- Snapshot responses omit approval authority and rich raw run payloads. Command output
  access verifies conversation/run membership. File traversal, state files and symlinks
  outside the project are rejected by the existing Workspace implementation.
- Managed native startup opts into the shared coding composition and includes provider
  identity in the runtime configuration fingerprint. Profile changes are blocked while
  known project runs are pending, including approval waits.
- General web-only startup remains opt-in for coding. The browser cannot invent or
  authorize a project root; it may request the native dialog only when supplied by its host.

<a id="stage-2-validation"></a>

### Validation

- `bun run check:assistant`: 141 source tests passed; offline smoke and installed-candidate
  validation passed (140 tests, one expected skip for the separate Code checkout).
- Additional Code integration assertions verify a real approved package check's command
  and exit code reach the workspace output projection. Seven application tests passed.
- Workspace HTTP tests cover unauthorized/foreign-Origin requests, rejected raw root
  input, native request correlation/cancellation, traversal/symlink/state exclusion,
  changed attachment digests, secret redaction, cross-conversation rejection and shutdown.
- Activity tests cover duplicate/out-of-order events, failed tools and expired cursors.
- `bun run packages/assistant/scripts/smoke-workspace.ts`: real host, temporary Git repo,
  simulated streaming provider, file attachment, tool result, navigation during execution,
  relative file links, reload without duplicates, cancellation and mobile layout.
- Actual release Tauri webview: native NSOpenPanel selection, file inspection/attachment,
  streaming `read_file` and response, session navigation, follow-up cancellation observed
  as **Detenida**. This used an isolated copy of the app with the same Rust shell, host,
  workspace routes and built UI; its child entrypoint supplied an offline model and
  temporary state. Managed onboarding and real provider calls were not part of this test.
  Reload/replay was verified in Chromium; a native reload shortcut is not provided.
- Architecture boundaries, root typecheck and 19 architecture/composition tests passed.
  Rust: two tests passed. The production Tauri bundle and its lifecycle smoke passed.

See [the evidence report](TAURI_STAGE_2_2026-11-13.json). Reproduce the browser
smoke after `bun run --cwd packages/assistant build`. For native fixture validation, bundle
`scripts/workspace-fixture.ts` as the temporary copy's child entrypoint and pass `--native`;
never replace the production host or use real profile state for that fixture.

<a id="stage-2-remaining-stages-and-distribution"></a>

### Remaining stages and distribution

Stage 3 adds native approval/diff/checkpoint review. Until then, pending coding approvals
must be handled through Code's attached service terminal; the workspace does not approve
them. Stage 4 adds an interactive terminal. No signed/notarized release, provider-backed
coding evaluation, Windows/Linux native chooser or OCI execution certification is claimed.
The built app retains the stage-1 local Harness candidate requirement: publish compatible
engine exports and update consumer pins before distributing against registry dependencies.
No commits, pushes, publication or changes to the user's profile were performed.

<a id="stage-3"></a>

## Assistant Tauri stage 3: review, checks and checkpoint recovery

Implemented locally on 2026-11-13, following [the agent plan](../plans/ASSISTANT_TAURI_AGENT_PLAN.md)
and extending [stage 2](ASSISTANT_TAURI_IMPLEMENTATION.md#stage-2). The shared Code composition and
Harness service remain authoritative. Existing local changes were preserved; no reset,
stash, commit, push or publication was performed.

<a id="stage-3-review-workflow"></a>

### Review workflow

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

<a id="stage-3-checks-and-explicit-task-acceptance"></a>

### Checks and explicit task acceptance

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

<a id="stage-3-checkpoints-and-interrupted-restores"></a>

### Checkpoints and interrupted restores

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

<a id="stage-3-verification"></a>

### Verification

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

See [the evidence report](TAURI_STAGE_3_2026-11-13.json). Build Assistant before
running the browser smoke. The native fixture entrypoint is `scripts/review-fixture.ts`
with `--native-review`; use a disposable copy of the bundle and supply the checkout path
in `ASSISTANT_REVIEW_CODE_ROOT` for its actual Code CLI invocation.

<a id="stage-3-remaining-boundaries"></a>

### Remaining boundaries

No live provider evaluation, signed/notarized release or OCI certification is claimed.
No interactive PTY, hunk-level decisions or automatic reconciliation was added. Stage 4
adds the interactive terminal and persistent task operation. The stage-1 local Harness
candidate remains necessary until compatible engine exports are published and consumer
pins are updated. Existing Desktop dependency issues were not changed by this work.

<a id="stage-4"></a>

## Tauri stage 4: terminal and persistent task operation

Stage 4 extends the existing Assistant application host and Code coding composition.
It does not introduce another agent executor or bypass desktop admission, review, or
checkpoint recovery. The current native preview targets macOS.

<a id="stage-4-interactive-terminal"></a>

### Interactive terminal

The project workspace has a separately labelled human-operated terminal. The Rust
shell owns a real PTY through pinned `portable-pty` 0.9.0; xterm 6.0.0 and addon-fit
0.11.0 load on demand. The authenticated loopback API sends correlated requests over
the existing private parent pipe. No renderer Tauri capabilities or arbitrary native
command invocation are enabled. The host resolves a registered project key to its
canonical directory; the renderer cannot supply a cwd or executable.

The shell is `/bin/zsh -l` with an explicit environment allowlist. Provider credentials,
application bearer tokens, and Node injection options are not inherited from the host.
The user's shell startup files can still configure their own shell environment. This
is a local user shell, not an agent sandbox. Typing commands does not approve agent
operations; existing stage-3 content checks reject stale review/checkpoint evidence
when shell commands change files.

There are at most eight terminals. Each has a 256 KiB output ring, 16 KiB read pages,
2,000 frontend scrollback lines, bounded input, resize, Ctrl+C, and explicit close.
Switching views or hiding the window leaves the PTY alive. Closing a terminal or
quitting terminates ordinary foreground and background jobs in its POSIX session.
Deliberately detached daemons that create a new session are outside this ownership
boundary. Terminal sessions/output are not restored or replayed after process restart.

xterm's generated style elements receive a per-document CSP nonce through its document
override. The application keeps its script policy and does not enable `unsafe-inline`.
OSC 52 clipboard access and automatic terminal link activation are disabled.

<a id="stage-4-task-lifetime-and-recovery"></a>

### Task lifetime and recovery

- Closing the main window hides it. The native shell and Node host keep running;
  reopening from the Dock reveals the same workspace and activity.
- The Quit menu/Command-Q enters a host-owned decision flow: return to the app, wait
  for active agent work, or request cancellation. Admissions pause before drain/cancel.
  Cancellation can replace a pending drain. Failure to confirm shutdown leaves the app
  available for inspection instead of claiming success.
- This is background execution while the app is alive, not a launch daemon or automatic
  restart service. Parent-pipe EOF and host failure clean up the owned native terminals.
- Existing durable Harness stores reconcile interrupted runs and approvals on restart.
  Uncertain effects are never automatically replayed. The activity queue reads canonical
  `run.get` states rather than relying on session run references.
- The host persists the last project/conversation selection across loopback port changes.
  Restored identifiers are checked against the active profile's registered catalog.
  Terminal processes and unsent drafts are not restored.

Completion/attention notifications are disabled by default. Enabling them requests
actual macOS UserNotifications authorization; delivery uses the native notification
plugin and generic text without project paths or task content. Denied permission stays
disabled. Initial historical activity is not announced as newly completed work.

<a id="stage-4-verification"></a>

### Verification

Run `bun run check:assistant`, `bun run architecture:check`,
`bun run --cwd packages/assistant test:desktop`, and
`bun run --cwd packages/assistant build:desktop`.
`smoke:desktop` checks the staged runtime, private URL, lock, shutdown, restart, and EOF.
Pass the final app's `Contents/Resources/runtime` directory to
`scripts/smoke-desktop.ts` to validate the packaged runtime directly.
Run `bun run packages/assistant/scripts/smoke-desktop-settings.ts` to verify that
settings shutdown opens the native decision flow, returning keeps settings usable,
and standalone web shutdown retains its existing behavior. An optional first argument
selects the final bundle's `Contents/Resources/runtime/web/dist` assets.

The offline `scripts/persistent-fixture.ts` can replace `runtime/dist/desktop.js` only
inside a temporary copy of the built app for native acceptance checks. It registers a
temporary repository and uses a delayed mock model; no provider call is made. Never
replace the production bundle's host with a fixture.

Evidence and remaining validation limits are recorded in
[the stage-4 report](TAURI_STAGE_4_2026-11-13.json).

Dependency references: [portable-pty](https://docs.rs/portable-pty/0.9.0/portable_pty/)
and [xterm Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/).

<a id="stage-5"></a>

## Tauri stage 5: isolated tasks and Git delivery

Stage 5 reuses Code's coding composition and adapts Desktop's worktree, commit,
GitHub transport, push, and pull-request adapters into the Assistant host. The
renderer imports no privileged Git implementation. All actions use the existing
bearer/Origin-protected workspace API and registered project identities.

<a id="stage-5-task-ownership-and-limits"></a>

### Task ownership and limits

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

<a id="stage-5-reviewed-delivery"></a>

### Reviewed delivery

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

<a id="stage-5-verification"></a>

### Verification

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
[stage-5 report](TAURI_STAGE_5_2026-11-13.json).

<a id="stage-6"></a>

## Tauri stage 6: previews, browser verification and artifacts

Stage 6 adds an explicitly reviewed static preview pipeline to the existing Assistant
workspace. Code still builds the application through its reviewed checks, or the human
uses the stage-4 terminal. The preview adapter never introduces another shell executor.

<a id="stage-6-user-journey"></a>

### User journey

1. Build a static web output in a project or isolated task, for example `dist`.
2. Open **Previews y evidencia**, select that relative directory, and review its complete
   file list, byte count and content digest. Confirm publication explicitly.
3. Assistant captures those files and starts its own static server process on a new
   OS-assigned loopback port. The server serves only that immutable capture.
4. Review and authorize a separate browser plan. The UI supports a relative path and
   visible-text assertion; the agent tool additionally supports bounded clicks.
5. Inspect the screenshot, exact plan, outcome, timestamp, output digest and observed Git
   revision. Comments create separate immutable records anchored to the evidence ID.
6. Stop the previews explicitly, close the task environment, or quit Assistant. Servers
   expire after 30 minutes. They do not resume automatically after a restart.

This supports static HTML and compiled static exports. It does **not** attach to existing
ports, run arbitrary framework dev-server commands, proxy remote applications, provide
HMR, or verify applications requiring a backend. Use Code/terminal for builds. Source
provenance records the project observed at publication; it is not proof that a build
actually incorporated that source. The screenshot proves only the displayed plan against
those captured output bytes, not comprehensive visual correctness.

<a id="stage-6-composition-and-compatibility"></a>

### Composition and compatibility

- `src/preview/controller.ts` owns publication reviews, process and browser lifetimes,
  bounded artifacts and a fixed in-process MCP client.
- `src/preview/preview-server.ts` is a separately bundled worker. It receives captured
  files over private IPC and never reads the repository or imports the privileged host.
- `src/preview/revision.ts` fingerprints HEAD and bounded nonignored working files,
  including dirty and newly created files. State under `.zhivex-harness` is excluded.
- New local Code runtimes expose `preview_verify` through the public Harness MCP API.
  Network permission keeps every invocation approval-gated. The existing stage-3 review
  receipt binds the exact origin, preview ID, content digest and plan.
- Previously initialized runtimes retain their prior tool composition and fingerprints.
  `preview-tools.binding` enables the capability only in newly initialized local runtimes.
  Existing pending approvals remain resumable. Create a new isolated local task to use the
  browser tool with the agent; manual verification is available in existing environments.
- OCI runtimes do not receive this host-side tool: their existing no-network boundary is
  retained. Manual verification is a separately authorized host operation.
- Authenticated workspace routes and the native desktop lifecycle are reused. The browser
  is separate from the Tauri webview and receives no Assistant bearer or provider secrets.

<a id="stage-6-boundaries-and-limits"></a>

### Boundaries and limits

Publication tickets are single-use, expire after five minutes, and recheck captured output
before starting. At most two preview processes run concurrently. The worker owns its
listening socket; no available-port probe or foreign process is accepted as ownership.
It checks the exact Host header, serves only GET/HEAD, sends no CORS grants and denies
frames, forms, objects and external subresources with CSP. Hidden files, `node_modules`,
symlinks, unsupported extensions and paths outside the selected directory are excluded
or rejected. Reads reuse the desktop-derived no-follow reader. Limits are 512 served files,
2 MiB per file, 16 MiB total, 2,048 directory entries and depth 12.

Chromium uses a fresh context, blocked service workers, disabled download acceptance,
closed popup pages and blocked WebSockets. HTTP requests must stay at the exact owned
origin. Plans allow at most ten clicks/text assertions, no arbitrary evaluation, and a
30-second deadline. Screenshots are fixed at 1280 × 800 and bounded to 2 MiB. This is an
application/network boundary, not an OS sandbox for Chromium vulnerabilities. The separate
preview origin has no credentials capable of calling privileged host operations.

Evidence lives in the private host state directory `preview-artifacts`, outside worktrees.
A durable running record precedes browser launch; an atomic final record stores success
or failure and the PNG digest. Interrupted records become failed evidence after restart;
checks are never replayed. Evidence is limited to 500 records/64 MiB. Full storage refuses
new evidence instead of silently deleting it. Existing images are integrity-checked on load.
Output and source revisions are recomputed when listing artifacts. Unknown source state
is never shown as fresh. Source hashing is bounded to 4,096 Git-listed files, 2 MiB per file
and 32 MiB total; unsupported files or limits produce unknown provenance.

Playwright is a production dependency. Chromium must be installed for that runtime version
in the user's normal Playwright cache (`playwright install chromium`); the app does not
silently download a browser. A missing browser yields visible failed evidence. Browser
binary provisioning and signed distribution belong to the stage-7 packaged pilot.

<a id="stage-6-validation"></a>

### Validation

The stage-6 tests exercise immutable publication, one-use/stale review tickets, rejected
symlinks/hidden-file access, Host/method checks, cross-project denial, real Chromium clicks
and text assertions, blocked requests to another local server, persisted screenshots,
failed checks, feedback, stale evidence, restart and cleanup. An offline model uses the
actual Code composition and cannot create browser evidence before the stage-3 approval.

`bun run packages/assistant/scripts/smoke-preview.ts` exercises the rendered UI, separate
publication/browser confirmations, screenshot display, feedback, stale labels and a
390-pixel viewport. The full `check:assistant` suite also tests a separately installed
consumer. See the [stage-6 validation report](TAURI_STAGE_6_2026-11-13.json) for the
observed results and limitations.
