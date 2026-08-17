# CLI contract

Zhivex Harness `0.4.x` is Bun-first and exposes a human terminal interface plus versioned JSON documents for automation.

## Commands

```text
zhivex-harness run [options] "task"
zhivex-harness chat [options]
zhivex-harness providers [--json]
zhivex-harness doctor [options] [--json]
zhivex-harness resume [options] <runId> --approve|--deny
zhivex-harness runs list [--status <status>] [--limit <n>] [--cursor <cursor>]
zhivex-harness runs inspect <runId>
zhivex-harness runs export <runId>
zhivex-harness runs cancel <runId> [--reason <text>] [--cascade] [--final]
zhivex-harness runs cleanup --before <date|timestamp> [--status <status>] [--limit <n>]
zhivex-harness --version
zhivex-harness --help
```

`doctor` is local and makes no provider request. It checks the Bun version, workspace, Git, supported package scripts, state-directory safety, provider credential presence, endpoint shape, and provider configuration without returning secret or endpoint values.

`--allow-check <script>` is repeatable and replaces the default check allowlist for that invocation. Values are declared `package.json` script names, never command text.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully. |
| `1` | Runtime, provider, or agent failure. |
| `2` | Invalid CLI usage. |
| `3` | `doctor` found a blocking configuration problem. |

Agent results with status `failed` or `timed_out` return `1`. A paused approval is a valid durable result and does not imply a runtime failure.

Operator commands do not construct a provider model and do not require provider credentials. They must use the workspace, state directory, backend, and scope that own the target run. `cancel` creates a cooperative cancellation request by default; `--final` writes a terminal cancellation. `cleanup` requires an explicit cutoff and defaults to terminal statuses only.

## JSON schemas

All structured documents include:

```json
{
  "schemaVersion": 1,
  "kind": "providers | doctor | run-result | run-list | run-inspection | run-export | run-cancellation | run-cleanup"
}
```

Additive fields may appear within schema version `1`. Removing a field, changing its meaning, or changing a field type requires a new schema version and a migration note. Human-readable output is not a machine contract.

Provider diagnostics include credential variable names and boolean presence only. Endpoint diagnostics include validation booleans only. Neither contract contains credential values or endpoint URLs.

`run-result.mutations` contains the mutation audit entries produced by the current harness process. Operational inspect/export documents are redacted and do not include raw messages, tool inputs/outputs, approval arguments, metadata, or full output text. Tool-level repository-editing documents use their own schema version `1` and kinds such as `edit-proposal`, `patch-result`, `mutation-audit`, and `workspace-diff`; see [REPOSITORY_EDITING.md](./REPOSITORY_EDITING.md).

## Configuration schema

Resolved library configuration includes `schemaVersion: 2`, an explicit `allowedChecks` array, `storeBackend`, `scope`, `budget`, and `compaction`. The check default is `test`, `typecheck`, `lint`, and `build`; `--allow-check` or `ZHIVEX_HARNESS_ALLOWED_CHECKS` replaces that set. Passing a different explicit schema version fails before a model or tool can run. During `0.x`, a minor release may add a new schema version with a documented migration; patch releases remain compatible.

The default state directory is `<workspace>/.zhivex-harness/runs` and the default backend is scoped SQLite at `operations.sqlite`. Explicit external state directories are supported, but the workspace root, filesystem root, sensitive workspace paths, regular files, and symbolic-link targets are rejected before the run store is created. See [DURABLE_OPERATIONS.md](./DURABLE_OPERATIONS.md) for flags, environment variables, defaults, state migration, budgets, and export limits.
