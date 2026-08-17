# Durable operations

Zhivex Harness durable operations make local runs inspectable and recoverable across process restarts. The default store is Bun SQLite at `<workspace>/.zhivex-harness/runs/operations.sqlite`; `--store file` remains a migration fallback.

## Scope and identity

Every durable key is isolated by:

- tenant: `local` by default;
- optional user;
- namespace: a SHA-256-derived canonical-workspace identifier by default.

Use the same workspace, state directory, backend, tenant, user, and namespace for `run`, `resume`, and every `runs` command. A run fingerprint is bound to the canonical workspace, durable scope, provider/model, tool contract, approval policy, config schema, harness version, and execution-environment policy. Under OCI, the resolved image identity is also bound. Resume fails closed when a current binding differs.

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

The golden baseline is packaged at `evaluations/golden-expectations.json`. It is regression evidence, not live-provider certification. Provider behavior must still pass the opt-in, credentialed live gate described in [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).
