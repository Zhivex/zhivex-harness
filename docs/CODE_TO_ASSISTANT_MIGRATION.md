# Gradual Code-to-Assistant migration

Status: proposed implementation plan, 2026-11-11. No runtime migration has been performed.

## Objective and boundaries

Assistant becomes the single product for general assistance and coding. The terminal
remains a first-class interface alongside the web. Code's product orchestration and
coding experience move into Assistant; the terminal is not retired. Harness remains
the execution and governance engine, independently usable by embedding applications.

This plan covers the current working tree, including ongoing Assistant onboarding
and provider changes. Existing local changes must be preserved. Desktop integration
is outside the initial cutover; its public Harness contracts remain compatible.

## Current architecture

- `packages/code/src/cli.ts` selects direct execution or `--service-file` mode.
- `packages/code/src/cli/configured-harness.ts` constructs coding runtimes and owns
  product choices for credentials, model routes, budgets and project memory.
- `packages/code/src/cli/console.ts` directly manages runtimes. Its `console/` helpers
  mix terminal interaction with task orchestration and review behavior.
- `packages/code/src/cli/service-client-cli.ts` already implements session/run,
  activity replay, cancellation and approval interaction over the local service.
  Its command coverage is narrower than the direct console; it is a starting point,
  not a feature-equivalent replacement.
- `packages/code/src/web-entry.ts` starts another coding runtime and embeds the UI
  from `packages/web`; Assistant has a separate web server and React application.
- `packages/assistant/src/host.ts` owns one general runtime in a private workspace,
  with project context, project memory, delegation and execution disabled.
- `packages/assistant/src/client.ts` connects to one negotiated project. Its local
  promise queue is not a lock shared by multiple clients.
- `src/client/adapter.ts` binds one workspace/scope to a project ID. The protocol
  already exposes task review, checkpoints, restore, revisions and approval digests.
- `createHarness` and `createProfiledHarness` share runtime implementation. General
  profiles currently reject delegation; changing profile content changes durable
  bindings. Profiles are not a mechanism for silently converting existing runs.
- Assistant's module contract is designed around MCP tools and has Calendar-specific
  integration hooks. It is not yet a generic coding capability contract.
- Assistant requires a locally prepared Harness candidate. Code has installed-package
  CI coverage; Assistant needs equivalent coverage. The architecture traversal omits
  Code source today.

## Target ownership

```text
Terminal                Assistant Web                Channel adapters
    \                         |                            /
               Assistant application host
        conversations / projects / runtime registry
        configuration / connections / activity routing
                       |                 |
                general runtime     coding runtime per project
                       \                 /
                           Harness
       execution / tools / policy / approvals / runs / checkpoints
```

One application does not require one mutable Harness instance. Initially preserve
separate general and project runtime bindings, managed by one Assistant host.
Separate runtime instances do not imply a required process-per-project design.

| Owner | Responsibility |
| --- | --- |
| Harness | Tool execution, durable approvals, scopes, budgets, run state, checkpoints, execution isolation and engine protocol |
| Assistant host | Product configuration, project registry, conversation-to-runtime references, lifecycle, connections and cross-client routing |
| Coding capability | Coding runtime composition, project-specific defaults and coordination through public engine APIs |
| Terminal and web | Input, rendering, navigation, concrete review presentation and calls to the application client |
| Existing Code package during transition | Compatibility executable and fallback direct implementation until its replacement reaches parity |

Keep personal memory separate from project memory. Share provider connection
normalization; keep credential storage and interactive prompts in host/UI adapters.
Promote reusable `code-support` helpers into named public domain APIs incrementally,
retaining compatibility exports. Do not move terminal dependencies into Harness.

## Phase 0 — Freeze the behavioral baseline

Deliverables:

- Inventory Code commands and options: chat/run/resume, sessions, task review,
  checkpoints/restore, model routing, subagents, budgets, credentials, memory,
  audit/state operations, stdin, JSON/JSONL, exit codes and terminal interactions.
- Record each feature as required for initial coding delivery, later parity, or
  intentionally retained as an advanced engine administration command.
- Add Code to architecture traversal and prohibit product internals crossing boundaries.
- Add Assistant installed-candidate CI: build Harness, prepare the package consumer,
  typecheck, test, and offline smoke using its packaged public exports.
- Establish explicit package/version compatibility. Local candidate setup is permitted
  during development; distribution must pin a released version containing required APIs.

Gate: existing Code and Assistant journeys pass independently, and the feature matrix
has no unclassified behavior. Baseline test results identify the exact candidate artifact.
Rollback: no behavior changes in this phase.

## Phase 1 — Introduce an Assistant application client

Deliverables:

- Add application-level client/contracts inside Assistant, without introducing a new
  published package until there is a demonstrated packaging need.
- Reuse Harness commands and event shapes for engine operations. Add only product
  operations such as project registration, conversation lookup and runtime selection.
- Separate client-safe contracts from Node host implementation in package exports.
- Generalize connection management, capability negotiation, activity replay and error
  handling shared by Assistant and the existing service terminal client.
- Enforce mutation ordering at the authoritative host/runtime, not merely in a client
  queue. Preserve expected revisions, approval digests and actual idempotency semantics.
- Document reconnect behavior: inspect authoritative state before retrying uncertain
  mutations. Do not infer cross-connection idempotency from connection-scoped keys.

Gate: terminal and web can observe the same general conversation; concurrent changes
produce explicit conflicts; reconnect rebuilds a view from snapshot plus event cursor.
Rollback: opt-in application client; existing entrypoints remain available.

## Phase 2 — Add project-bound coding runtimes

Deliverables:

- Add a host-owned registry of canonical project paths, scope references and runtime
  bindings. Conversation records reference a runtime/session; they do not duplicate
  Harness checkpoints or approval state.
- Keep the current private workspace for general conversations initially. General
  users do not need to select a repository just to converse.
- Register repositories through an explicit local user action; channel messages do
  not grant filesystem access or choose arbitrary host paths.
- Extract coding composition from `configured-harness.ts` into a UI-independent
  Assistant capability. Use `createHarness` for coding initially, preserving defaults;
  retain `createProfiledHarness` for general conversations.
- Introduce a small runtime factory/capability descriptor instead of forcing coding
  into `AssistantModule`'s MCP-only shape. Existing modules continue unchanged.
- Define runtime lifecycle, bounded concurrency, exclusive ownership, shutdown,
  stale-owner recovery and refusal to open an already-owned project store.
- Expose capabilities available to each conversation and deny unsupported operations
  at the host. UI visibility alone does not enforce permissions.

Gate: one Assistant host supports general conversation plus two isolated projects;
tools, memory and approvals cannot cross scopes. Changing a conversation's execution
context creates an explicit new binding rather than resuming an incompatible run.
Rollback: coding project registration is opt-in; no legacy stores are rewritten.

## Phase 3 — Deliver the first coding journey in the terminal

Deliverables:

- Extend the service terminal path to select an Assistant project and execute a coding
  task through the application client. Reuse terminal rendering and input components.
- Implement the vertical journey: select project, request edit, inspect changes,
  resolve required approvals, execute configured checks, inspect evidence and continue.
- Use existing `task.*`, `run.*`, checkpoint and restore contracts where they fit;
  distinguish authorization to execute an effect from acceptance of the final changes.
- Preserve reviewed-operation semantics. Never expose `dispatchReviewed` as a generic
  client claim; the trusted host must verify the concrete review flow.
- Preserve Ctrl-C, interactive streaming, stdin, noninteractive commands and machine
  output contracts for the migrated command subset.

Gate: offline fixtures exercise successful edit/check, rejected approval, failed check,
stale file, cancellation, disconnect and recovery without duplicate execution.
Rollback: select the legacy backend before starting a run. Never fail over automatically
after a potentially mutating request or open a second writer to its store.

## Phase 4 — Consolidate the coding web experience

Deliverables:

- Port useful views and interactions from `packages/web` into Assistant web: project
  selection, task progress, diffs, review evidence, checks and checkpoint recovery.
- Route these views through the same application client as the terminal; avoid copying
  the independent runtime factory from `packages/code/src/web-entry.ts`.
- Extend Assistant web review handling for coding actions while retaining existing
  Calendar/MCP authorization and concrete preview requirements.
- Reconcile activity snapshots on attachment/reconnection, including expired cursors.

Gate: start a task in the terminal, inspect/review in web and continue in terminal;
simultaneous approvals yield one authoritative decision and an explicit stale response.
Rollback: keep the old coding web available for legacy runtimes only; enforce one owner.

## Phase 5 — Reach Code feature parity and migrate existing users

Deliverables:

- Complete the Phase 0 matrix: model switching/routing, subagents, compaction, budgets,
  project memory, restore, audit and state tooling as applicable to each interface.
- Centralize provider connection schemas and endpoint normalization with compatibility
  adapters for existing Code/Assistant settings. Keep established credential references
  intact or migrate them explicitly; do not copy secrets into project configuration.
- Add explicit extension/configuration identity to runtime bindings before replacing
  instruction-embedded configuration digests. Preserve old binding interpretation.
- Implement a preflight/report for existing Code workspaces: versions, scope, ownership,
  pending work, settings and credential references. Back up before any format conversion.
- Prefer adopting compatible existing stores through public APIs. If bindings differ,
  retain history and link a new session; do not rewrite fingerprints or approval digests.
- Let active runs and pending approvals finish under their original compatible runtime,
  or require explicit cancellation/reconciliation before switching ownership.

Gate: installed-artifact tests cover old-to-new upgrade, pending approval handling,
interrupted migration and restore from backup. Each parity row has evidence or an
explicitly documented retained command path.
Rollback: release ownership and return to the old compatible artifact/store. If a schema
upgrade prevents downgrade, restore the backup; document any post-backup history limits.

## Phase 6 — Make Assistant the default and retire duplicate composition

Deliverables:

- Make the terminal start/connect to Assistant by default. Specify startup discovery,
  ownership and lifetime explicitly; starting web must attach to the same host.
- Keep `zhivex-code` as a compatibility command during a documented transition, forwarding
  supported arguments to Assistant terminal. Final executable naming is a release choice,
  not a prerequisite for earlier phases.
- Move terminal implementation to an Assistant-owned location only after dependency
  extraction; use public client exports from any separately packaged compatibility shim.
- Remove direct Code runtime composition and duplicate coding web hosting once parity
  and upgrade gates pass. Remove fallback paths only after a validated release interval.
- Update installation, support matrix, package smoke tests, docs and release workflows.

Gate: all supported general and coding product journeys run through Assistant from
terminal and web, with one authoritative lifecycle and no hidden direct-Code backend.
Harness embedding and Desktop public contract checks still pass.

## Deferred engine refactoring

After the project runtime journey is proven, separate optional workspace/tool-bundle
composition from the general Harness bootstrap, generalize delegation where needed,
and move reusable code-support operations behind stable domain exports. Retain the
stable coding constructor as a compatibility facade. Do not block the product migration
on a complete generic runtime redesign or a new plugin framework.

## Suggested first implementation slices

1. Baseline feature matrix, architecture coverage and installed Assistant CI.
2. Client-safe Assistant contracts and shared connection/replay implementation.
3. Project registry and runtime factory using existing constructors.
4. Terminal coding journey against the Assistant host.
5. Matching Assistant web journey and cross-interface concurrency tests.
6. Remaining parity, configuration/state migration and compatibility executable.
7. Default cutover, followed by deletion of redundant composition after validation.

Each slice should preserve a working product and include only the tests needed for its
new boundary or behavior. Release decisions follow acceptance gates rather than assumed
calendar estimates. This document proposes implementation work; it does not change runtime behavior.
