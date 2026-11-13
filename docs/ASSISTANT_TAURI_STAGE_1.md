# Tauri agent workspace: stage 1 project host

Implemented 2026-11-13 against the local Harness candidate. This delivers stage 1 of
the [workspace plan](ASSISTANT_TAURI_AGENT_PLAN.md): a general Assistant host plus
project-bound coding runtimes, with Code's terminal attached to those runtimes.
The Tauri folder picker, workspace panels and event UI remain stage 2.

## Shared composition

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

## Host and application client

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

## State, identity and ownership

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

## Execution and concurrency

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

## Try from the checkout

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

## Verification and limits

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
artifact evidence are recorded in [the stage-1 report](reports/TAURI_STAGE_1_2026-11-13.json).

This is offline/mock-provider evidence plus real local filesystem, Git, process and
package-check execution. No live provider, real OCI container, Tauri workspace UI or
signed distribution is certified. Desktop's pre-existing dependency/backup failures
from stage 0 were not changed or rerun as part of this implementation.

The new engine exports are available in the local candidate only. Publish a compatible
Harness release and update consumer pins before distributing Code or Assistant against
registry dependencies; the existing `1.6.3` pin does not establish published availability
of these new exports. No publication, migration or commit was performed here.
