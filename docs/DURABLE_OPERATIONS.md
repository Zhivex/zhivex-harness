# Durable operations

Zhivex Harness durable operations make local runs inspectable and recoverable across process restarts. The default store is runtime-portable SQLite at `<workspace>/.zhivex-harness/runs/operations.sqlite`, backed by `node:sqlite`; `--store file` remains a migration fallback. The `0.10.x` runtime change does not alter the SQLite file or table format.

Before creating session or run state, Harness writes a local `.gitignore` that excludes all contents of `.zhivex-harness/` (or the configured custom state directory), including SQLite journals and file-store records. This protects untracked files from ordinary `git add`; it cannot override `git add --force` or untrack files already committed. If state was previously tracked, add `.zhivex-harness/` to the repository's root `.gitignore` and use `git rm --cached` on the tracked state files to keep local data while removing it from future commits. Existing Git history is unchanged and must be assessed separately.

## Scope and identity

Every durable key is isolated by:

- tenant: `local` by default;
- optional user;
- namespace: a SHA-256-derived canonical-workspace identifier by default.

Use the same workspace, state directory, backend, tenant, user, and namespace for `run`, `resume`, and every `runs` command. A run fingerprint is bound to the canonical workspace, durable scope, provider/model, tool contract, approval policy, config schema, harness version, and execution-environment policy. Under OCI, the resolved image identity is also bound. Resume fails closed when a current binding differs.

Provider transport configuration is represented by a non-secret SHA-256 fingerprint too. Endpoint, region, and provider-workspace values are never persisted in plaintext, but changing them invalidates a paused run binding.

CLI-created runs persist the resolved non-secret harness configuration in versioned run metadata. The terminal prints a scope-complete locator command, and `resume` restores the original OCI policy before fingerprint validation, so approval restart does not silently fall back to `execution=none`. Explicit conflicting overrides are rejected by the existing binding check.

```bash
zhivex-harness run \
  --tenant acme \
  --user operator-7 \
  --namespace payments \
  --idempotency-key incident-482 \
  "diagnose and repair the regression"
```

An idempotency key atomically reserves one run inside its scope. Repeating the request returns the existing durable state instead of starting another side-effecting run. SQLite leases and compare-and-swap revisions prevent concurrent workers from silently owning the same checkpoint, while the tool journal records exactly-once claims for side effects.

## Operator commands

Operator commands open the store directly. They do not create a provider model and do not require provider credentials.

```bash
zhivex-harness runs list --status waiting_approval --limit 50
zhivex-harness runs list --cursor <opaque-cursor> --json
zhivex-harness runs inspect <runId> --json
zhivex-harness runs export <runId> --json
zhivex-harness runs cancel <runId> --reason "superseded"
zhivex-harness runs cancel <runId> --cascade --final
zhivex-harness runs cleanup --before 2026-08-01T00:00:00Z
```

`cancel` records a cooperative `cancel_requested` state by default. Use `--final` only when the operator intends to make cancellation terminal. `--cascade` includes known child runs. `cleanup` requires an ISO-8601 date or millisecond timestamp; without `--status`, it removes only `completed`, `failed`, `cancelled`, and `timed_out` runs. The default maximum cleanup batch is 1,000.

`inspect` and `export` share the same redacted operational artifact. Export changes only the document kind to `run-export`; it does not create an unredacted archive on disk.

## Durable CLI sessions

The console maintains a scoped session index in prefixed tables inside `operations.sqlite`. A session is an ordered chain of immutable run references; it is not a mutable provider run. The index stores session ID/title, parent/fork metadata, run ID, provider, model, role, status, and timestamps. It never stores prompts, messages, tool calls/results, approval arguments, provider data, or environment values.

```bash
zhx chat
zhx chat --continue
zhx chat --session <sessionId>
zhx sessions list
zhx sessions inspect <sessionId> --json
zhx sessions rename <sessionId> "checkout repair"
zhx sessions fork <sessionId>
zhx sessions archive <sessionId>
```

The store uses SQLite WAL transactions, optimistic revisions, workspace/scope hashes, owner-only permissions, soft deletion/retention, and bounded session/run/metadata/index sizes. It rejects a new run while the latest session run is active or waiting for approval. Fork and archive operations also require a terminal branch point.

SQLite runs store steps, tool results and compaction records separately from the active checkpoint. Large repeated text is retained in per-run content-addressed artifacts. Checkpoint and history changes commit in the same transaction; unchanged historical records are not rewritten. The 4 MiB state limit applies to the active checkpoint, including current messages, approvals, metadata and counters. Conversation compaction still controls model input size independently.

Loading a run reconstructs its complete state for compatibility with approvals, recovery and verification. Programmatic history inspection can use `store.loadHistory(runId, { field: "toolResults", offset: 0, limit: 50 }, scope)` to read a page. Full hydrated states and total disk usage can grow with the run; run retention remains necessary. File and in-memory stores retain the full-state size limit.

Logical backups contain hydrated history rather than database references, so restoration does not require the original artifact tables. Exports up to 64 MiB retain the legacy JSON format; larger exports use the versioned `ZHIVEX-STATE-SEGMENTS-1` transport with bounded frames, including split strings. RC13 reads both formats and verifies the same logical checksum before import. Older versions cannot read segmented exports. File I/O and checksum serialization are incremental; the public backup/import APIs still hydrate the complete logical bundle in memory. Segmented files have no aggregate 64 MiB ceiling. A state-limit failure records a bounded terminal diagnostic on the last durable checkpoint; the unsaved payload is not claimed as preserved. Use `/status` to inspect the failed run before `/continue`. Recovery retains tool journal receipts and never re-executes an operation itself.

Incremental SQLite history uses the published Core 1.26.0 and Agents 1.10.1 packages. No local dependency patch is required. Install this checkout with `bun install --frozen-lockfile`.

## Provider handoff safety

Every console turn preallocates a new run ID and binds it permanently to one provider/model. Provider or model changes take effect only on the next run and are blocked while an approval is pending. Before transferring context to another provider/model, the console creates a bounded deterministic redacted summary: text is truncated and common credentials are removed, while tool inputs, outputs, and provider payloads are replaced by tool/type names.

Per-role routes are stored as non-secret provider/model metadata in the durable resume envelope so an approval restart reconstructs the same subagent models and fingerprint. A route never performs in-run failover. Heterogeneous routes cannot be combined with the single-price `--max-cost-usd` contract in `0.11.x`.

## Budgets

Default limits are:

| Budget | Default |
| --- | ---: |
| Steps | 12 |
| Wall clock | 900,000 ms |
| Tool calls | 32 |
| Tool errors | 4 |
| Input tokens | 100,000 |
| Output tokens | 30,000 |
| Total tokens | 120,000 |

Configure them with `--max-steps`, `--timeout-ms`, `--max-tool-calls`, `--max-tool-errors`, `--max-input-tokens`, `--max-output-tokens`, and `--max-total-tokens`. Production guardrails stop the run and persist a clear termination reason when a measured limit is reached. Meta and OpenAI receive a compatible output ceiling. Qwen Responses cannot accept `maxTokens`, so its token limits are checked durably before and after a provider step; one step can cross a measured token limit before the output guard observes it.

Cost is optional because provider/model pricing is not inferred:

```bash
zhivex-harness run \
  --max-cost-usd 0.50 \
  --input-cost-per-million 2.50 \
  --output-cost-per-million 10 \
  "review the repository"
```

At least one pricing value is required with `--max-cost-usd`. Missing input or output pricing is treated as zero. Cost uses provider-reported token usage and operator-supplied prices; it is not a billing record and a single provider step can cross the ceiling before the post-step guardrail observes it.

## Context compaction

The default compactor activates at 60 messages or an estimated 40,000 input tokens, retains the 12 most recent messages, and records each compaction durably. The summary includes roles, bounded text, and tool names rather than raw tool payloads. Library users can configure `compactionMaxMessages`, `compactionMaxEstimatedInputTokens`, and `compactionKeepRecentMessages`; corresponding environment variables are listed below.

## Redaction and exports

Operational artifacts are schema version `1`. By default they exclude raw messages, tool inputs, tool outputs, approval arguments, run metadata, and full output text. Traces, ledger previews, and journal errors apply the production secret/email redaction policy. This is a defensive export boundary, not a guarantee that arbitrary model-generated prose can never contain sensitive business data; control prompt contents and workspace permissions accordingly.

## Migration from 0.10.x

Version `0.11.0` advances configuration schema `4` to `5` and binds project context, progressive skill metadata, trusted application hook identities, and OCI shell mode into durable compatibility. The SQLite schema and file format do not change.

Library callers can migrate a persisted configuration input without reading process environment or filesystem state:

```ts
import { migrateHarnessConfigInput, resolveHarnessConfig } from "@zhivex-ai/harness";

const migrated = migrateHarnessConfigInput({
  schemaVersion: 4,
  provider: "openai",
  executionBackend: "oci"
});
const config = resolveHarnessConfig(migrated.config);
```

The schema `4` migration writes `projectContext: false` and, for OCI, `ociShellMode: "deny"`. This preserves the old authority surface; enable either feature only after reviewing the repository and policy. Schema `5` migration is idempotent. Unversioned, older, and future inputs fail closed.

Complete or deny paused `0.10.x` approvals with the exact `0.10.x` artifact and context that created them. The config migrator does not rewrite run metadata, tool fingerprints, or approval authority. New `0.11.x` runs enable bounded project context by default; disable it explicitly when required, and await `harness.close()` so asynchronous lifecycle hooks and execution-environment cleanup finish.

The historical migration gate is backed by SQLite files captured byte-for-byte from the exact published `0.10.0` and `0.11.1` tarballs after SHA-512 verification, paired with logical JSON expectations and recorded database digests. `bun run migration:check` copies and opens both historical databases with the current runtime, and CI repeats the compiled verifier on the supported Node.js lines. Regenerate them only with `bun run migration:fixtures`; the generator verifies registry integrity and never executes package lifecycle scripts. See [`fixtures/migrations/README.md`](../fixtures/migrations/README.md) and [GA_READINESS.md](https://github.com/Zhivex/zhivex-harness/blob/main/docs/GA_READINESS.md).

## Migration from 0.9.x

Before invoking `0.10.x`, install Node.js `22.13.0` or newer; Bun is no longer required to run the packaged CLI. Back up the state directory, then complete or deny paused approvals with the exact `0.9.x` artifact that created them before installing the exact `0.10.x` artifact. After upgrading, run `zhx doctor`, `zhx runs list`, and `zhx sessions list` against the same workspace and scope.

`0.10.0` keeps configuration schema `4`, final JSON schema `1`, all durable table names, and the SQLite file format. The runtime now opens the same database through `node:sqlite`, so existing `operations.sqlite` files require no conversion or export/import step.

Paused `0.9.x` approvals remain bound to their original harness version, tool contract, and execution policy; `0.10.x` intentionally rejects an incompatible resume. Completed `0.9.x` runs and sessions remain available for redacted inspection, while new runs select npm, pnpm, Yarn, or Bun from the repository's pinned `packageManager` or unambiguous lockfile. Bun-managed repositories should keep an explicit `packageManager` field or one Bun lockfile; OCI runs also need a Node-capable image and the selected package manager in the executable allowlist.

## Migration from 0.8.x

`0.9.0` retains configuration schema `4`, final JSON schema `1`, session tables, run-store layout, provider defaults, and both executable aliases. The new change-envelope commands are provider-free and do not add persisted run state.

The repository tool fingerprint changes because `read_files` and `search_many` join the read-only surface. Resolve or deny paused `0.8.x` approvals with the matching `0.8.x` artifact; `0.9.x` intentionally rejects a resume whose harness version or tool contract differs. Completed `0.8.x` runs remain available to redacted operator inspection, and new `0.9.x` sessions can start normally.

## Migration from 0.7.x

`0.8.0` keeps configuration schema version `4`, final JSON schema `1`, session storage, CLI commands, and both executable aliases. The OpenAI default changes from `gpt-5.4` to `gpt-5.6-luna`; pass an explicit model when retaining the previous behavior is required.

Paused `0.7.x` approvals are intentionally not resumable by `0.8.x`: the durable binding includes the harness version, so resume fails closed before a tool side effect. Resolve or deny them with the matching `0.7.x` artifact. Completed runs remain inspectable, and new `0.8.x` sessions can start from an explicitly compacted summary.

## Migration from 0.6.x

`0.7.0` keeps configuration schema version `4`, final JSON schema `1`, existing run commands, and the `zhivex-harness` binary. It adds the `zhx` alias, session tables, optional route metadata, and a JSONL event schema without rewriting existing run rows.

Paused `0.6.x` approvals are intentionally not resumable by `0.7.x`: the durable binding includes the harness version, so resume fails closed before a tool side effect. Resolve or deny pending `0.6.x` approvals with the matching `0.6.x` artifact before upgrading. Do not relax the fingerprint or edit stored state. Completed `0.6.x` runs remain available to redacted operator inspection; a new `0.7.x` session can start from an explicitly compacted summary.

## Migration from 0.3.x

Opening either backend under the default local/workspace scope scans legacy unscoped file-backed runs in the selected state directory. Runs absent from the scoped store are copied with their tool journals and marked `metadata.migratedFrom: "0.3-file-store"`. With the default backend the target is SQLite; `--store file` creates scoped file copies as a temporary compatibility path. Migration is idempotent and retains the unscoped source files for rollback; it does not delete or rewrite the legacy state. Custom tenant, user, or namespace scopes never import unscoped legacy data implicitly; library operators must call `migrateLegacyFileRuns` intentionally with the target scoped store.

Legacy paused approvals can be resumed explicitly. The harness writes the current binding before continuing, so subsequent resumes are protected by the `0.4.x` fingerprint. Review the pending approval before accepting it. If migration must be deferred, use `--store file`; do not point SQLite and file workers at the same logical request concurrently.

The SQLite state directory is owner-only and the database file is owner-readable/writable. Symlinked state directories and database files are rejected. Back up the state directory before moving scopes or performing manual database maintenance.

## Environment variables

CLI flags take precedence over these variables:

```text
ZHIVEX_HARNESS_STORE
ZHIVEX_HARNESS_TENANT_ID
ZHIVEX_HARNESS_USER_ID
ZHIVEX_HARNESS_NAMESPACE
ZHIVEX_HARNESS_MAX_STEPS
ZHIVEX_HARNESS_TIMEOUT_MS
ZHIVEX_HARNESS_MAX_TOOL_CALLS
ZHIVEX_HARNESS_MAX_TOOL_ERRORS
ZHIVEX_HARNESS_MAX_INPUT_TOKENS
ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS
ZHIVEX_HARNESS_MAX_TOTAL_TOKENS
ZHIVEX_HARNESS_MAX_COST_USD
ZHIVEX_HARNESS_INPUT_COST_PER_MILLION
ZHIVEX_HARNESS_OUTPUT_COST_PER_MILLION
ZHIVEX_HARNESS_COMPACTION_MAX_MESSAGES
ZHIVEX_HARNESS_COMPACTION_MAX_INPUT_TOKENS
ZHIVEX_HARNESS_COMPACTION_KEEP_RECENT
ZHIVEX_HARNESS_EXECUTION
ZHIVEX_HARNESS_OCI_RUNTIME
ZHIVEX_HARNESS_OCI_IMAGE
ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS
ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS
ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES
ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB
ZHIVEX_HARNESS_OCI_MAX_PIDS
ZHIVEX_HARNESS_OCI_MAX_CPUS
ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES
ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES
ZHIVEX_HARNESS_OCI_TMPFS_MB
```

## Evaluation gate

`bun run evaluate` executes five deterministic golden cases: analysis-only, approved edit-and-test, denied approval, SQLite restart recovery, and provider switching. It checks terminal status, exact tool sequence, maximum steps, a 30-second per-case latency bound, denied-write safety, and exactly-once recovery. `bun run check` runs this gate before the installed-tarball smoke.

The golden baseline is packaged at `evaluations/golden-expectations.json`. It is regression evidence, not live-provider certification. Provider behavior must still pass the opt-in, credentialed live gate described in [LIVE_CERTIFICATION.md](https://github.com/Zhivex/zhivex-harness/blob/main/docs/LIVE_CERTIFICATION.md).

To disable cumulative token ceilings explicitly, use `--no-token-budget` (library:
`unlimitedTokens: true`). It applies to the main run and subagents and persists
through resume. Token accounting and compaction continue; cost, time, steps, tools,
approvals, and provider per-request limits remain enforced. Stored numeric token
ceilings are inactive until `unlimitedTokens` is set back to `false`.

Next-version [project memory](PROJECT_MEMORY.md) reuses the existing SDK memory table and state export records. Historical state is not harvested into curated memory. Forget/clear remove current memory content, while backups, run histories and SQLite WAL retention remain separate. Older importers reject the new reserved memory key safely.

## Durable review groups (Beta)

`runHarnessReviewGroup` retains its ephemeral v1 contract. Applications can opt in
through `runHarnessDurableReviewGroup(harness, { groupId, prompt })`. The new API
uses the Harness scope, an application-owned root and a fixed roster of at most
two read-only explorer/reviewer members. This first implementation schedules
members serially. It requires a store with atomic idempotency claims, CAS saves
and fenced acquire/renew/release leases; the default SQLite backend supports them.
Custom stores must honor these contracts. No database schema migration is needed.

```ts
import {
  runHarnessDurableReviewGroup,
  inspectHarnessReviewGroup,
  cancelHarnessReviewGroup
} from "@zhivex-ai/harness";

const result = await runHarnessDurableReviewGroup(harness, {
  groupId: "review-request-42",
  prompt: "Inspect the public API boundary."
});
const snapshot = await inspectHarnessReviewGroup(harness, result.groupId);
// Cancellation can be requested from another worker using the same scope/store.
const cancellation = await cancelHarnessReviewGroup(harness, result.groupId);
```

A repeated ID must have the same prompt, ordered profiles, scope and member
runtime bindings. A mismatch fails before a model request. Completed members
replay their durable receipts; an interrupted group resumes the original member
IDs. A concurrent caller receives a retryable state conflict while the group
worker lease is held. After a worker dies, wait for lease expiry before retrying.
Inspection reconstructs results without executing a member. Keep the complete
state store when backing up or restoring; deleting a root or member is not a
supported way to reset a request.

Execution statuses include `blocked`, `partial`, `waiting_approval`, `suspended`,
`timed_out`, `cancel_requested` and `cancelled`. `partial` means all members are
terminal and some completed while others did not. Completion describes execution;
existing evidence and acceptance contracts still determine acceptance. The root
is visible to ordinary run inspection; its SDK status maps `partial` to `failed`,
and `blocked` maps to `suspended`, with the richer value in `harnessReviewGroupStatusV1`. Use group inspection for
the full result. Approvals are not automatically resumed by this API.

Cancellation records intention under the same fenced root lease used for fresh
member admission. Each admission is recorded before claiming a child checkpoint.
Subsequent model requests also check the root before dispatch. Already admitted
requests can finish late; cancellation does not roll back an external effect.
Terminal children are preserved, and active children receive durable cancellation
requests. Inactive queued, approval or suspended checkpoints become cancelled.
Confirmation requires every admitted child to have a terminal checkpoint. A cut
between recorded admission and child persistence remains `cancel_requested`
because the claim is uncertain; this tranche does not provide an automatic
reconciliation API for that cut. Repeated cancellation rechecks the fixed roster.

Generic cancellation of the root also closes group admission, but callers should
use the group cancellation API to preserve terminal member receipts; the SDK
's generic tree-cancellation semantics are unchanged.

This fence applies to the opt-in application-owned review group. It does not fix
the SDK's general parent/subagent admission and cancellation primitives. No
exactly-once guarantee for external effects, distributed scheduling or research
workflow acceptance is implied. Model tests use only offline mocks. Regressions
in `tests/durable-review-group.test.ts` cover repeated identity, interruption,
terminal preservation, concurrent callers and separate-process SQLite control.

Terminal replay reconciles the root's persisted status, member summaries and richer
group status before returning, including recovery after a cut following child
completion. Cancellation also reconciles its reconstructed projection. Internal
worker checkpoints are children of the group: they become `running` while leased,
`suspended` after an interrupted or blocked attempt, and terminal only after the
root's terminal projection is persisted. Recovery repairs an idle legacy worker
without taking ownership from a live worker. Default terminal cleanup can collect
finished groups and their workers; suspended coordination remains resumable.

New member records include an optional `checkpointed` marker, saved after the SDK
child claim and before request dispatch. If a previously persisted child disappears,
recovery blocks before transport and requires the complete backup. Existing records
without that marker remain readable; admitted members with missing receipts are
conservatively blocked. Admission and model dispatch also recheck receipt presence
under the root lock, so a stale caller snapshot cannot bypass the guard. Cleanup
while a group is active can remove an older terminal child's receipt and leave the
group blocked; it must not be used to reset or restart that child. Cancellation may
remain uncertain in this case. Retention deleting the entire group expires its
stored identity; no permanent deduplication beyond retained state is promised.

Groups modified by the checkpoint-marker fix require a current artifact. Older
artifacts with strict pre-marker schemas cannot read the additional marker;
downgrades require restoring a complete pre-upgrade backup.
