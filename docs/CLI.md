# CLI contract

Zhivex Harness `0.8.x` is Bun-first and exposes a durable agent console plus versioned JSON documents and JSON Lines events for automation.

## Commands

```text
zhx
zhx run --route reviewer=gemini [options] "task"
zhx run --jsonl [options] "task"
zhx chat [--continue|--session <sessionId>]
zhx sessions list|inspect|rename|fork|archive
zhivex-harness run [options] "task"
zhivex-harness review [options] "review task"
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

## Command compatibility

`zhx` and `zhivex-harness` point to the same installed executable. The short command is the primary interactive UX; the long command remains supported for existing scripts. Running `zhx` with no arguments in a TTY opens the console. An implicit prompt such as `zhx "inspect this repository"` and explicit `zhx run` remain one-shot executions.

## Interactive console

Each console session is a scoped, durable chain of immutable run IDs. The session index stores provider/model/status metadata and never stores prompts, model messages, tool payloads, or provider data; those remain in the governed run store. `zhx chat --continue` opens the latest session and `--session <id>` selects one explicitly.

```text
/provider [id]                 /model [id]
/route [role=provider[:model]] /route clear [role]
/status                        /diff
/review <task>                 /resume <last|sessionId>
/compact                       /new [title]
/rename <title>                /clear
/help                          /exit
```

Provider/model changes apply only to the next run. The console blocks them while the current run has an unresolved approval. Before a cross-model handoff it replaces future context with a bounded deterministic summary that redacts common credentials and retains tool names but not tool inputs or outputs. It never rebinds an existing run to another provider.

`/resume` selects a conversation session; it does not approve a run. A pending approval still requires the explicit operator command `zhx resume <runId> --approve` or `--deny`.

`doctor` is local and makes no provider or MCP request. It checks the Bun version, workspace, Git, supported package scripts, state-directory safety, provider credential presence, endpoint shape, provider configuration, the local MCP configuration file, and—when requested—the OCI runtime and preloaded image without returning secret or endpoint values.

`--allow-check <script>` is repeatable and replaces the default check allowlist for that invocation. Values are declared `package.json` script names, never command text.

`--require-capability <name>`, `--subagent <profile>`, and `--reviewer <explorer|reviewer>` are repeatable. `--mcp-config <path>` loads a schema-versioned file inside the canonical workspace. Child limits use `--subagent-max-steps`, `--subagent-max-tool-calls`, `--subagent-max-tool-errors`, `--subagent-max-input-tokens`, `--subagent-max-output-tokens`, `--subagent-max-total-tokens`, and `--subagent-timeout-ms`. Parallel review is capped by `--max-parallel-reviews`.

`--route <profile=provider[:model]>` is repeatable for `explorer`, `implementer`, `tester`, and `reviewer`. Omit the model to use that provider's default. Duplicate roles and unknown providers fail before a model is created. Only routed roles are instantiated. `--max-cost-usd` cannot be combined with routes in `0.8.x`, because the current budget has one operator-supplied price pair and cannot price heterogeneous child usage accurately.

`review` is application-owned parallelism and accepts only read-only explorer/reviewer members. Model-directed delegation occurs only inside `run` or `chat` when the parent invokes an enabled `delegate_<profile>` tool.

Enforced execution is opt-in:

```text
--execution <none|oci>
--oci-runtime <docker|podman>
--oci-image <reference>
--oci-allow-command <bare-name>
--oci-max-process-runtime-ms <n>
--oci-max-process-output-bytes <n>
--oci-max-memory-mb <n>
--oci-max-pids <n>
--oci-max-cpus <n>
--oci-max-workspace-bytes <n>
--oci-max-file-write-bytes <n>
--oci-tmpfs-mb <n>
```

`--oci-allow-command` is repeatable, replaces the default executable allowlist, and must include `bun` so declared package checks can run. Commands are exact argv arrays, never shell strings. See [EXECUTION_ENVIRONMENTS.md](./EXECUTION_ENVIRONMENTS.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully. |
| `1` | Runtime, provider, or agent failure. |
| `2` | Invalid CLI usage. |
| `3` | `doctor` found a blocking configuration problem. |

Agent results with status `failed` or `timed_out` return `1`. A paused approval is a valid durable result and does not imply a runtime failure.

Every new CLI run persists its resolved, non-secret harness configuration with the durable state. The printed resume command includes the canonical workspace, state-store backend, and scope locator; after loading the run, `resume` restores the original execution policy, including every OCI image, runtime, allowlist, and resource limit, before validating the harness fingerprint. Explicit conflicting resume options still fail closed. Runs created before this metadata existed must repeat their original policy options manually.

Operator commands do not construct a provider model and do not require provider credentials. They must use the workspace, state directory, backend, and scope that own the target run. `cancel` creates a cooperative cancellation request by default; `--final` writes a terminal cancellation. `cleanup` requires an explicit cutoff and defaults to terminal statuses only.

## JSON schemas

All structured documents include:

```json
{
  "schemaVersion": 1,
  "kind": "providers | doctor | run-result | review-group | run-list | run-inspection | run-export | run-cancellation | run-cleanup | session-list | session"
}
```

Additive fields may appear within schema version `1`. Removing a field, changing its meaning, or changing a field type requires a new schema version and a migration note. Human-readable output is not a machine contract.

Provider diagnostics include credential variable names and boolean presence only. Endpoint diagnostics include validation booleans only. Neither contract contains credential values or endpoint URLs.

`run-result.mutations` contains the mutation audit entries produced by the current harness process. `run-result.children` reports bounded child identity, status, steps, tool/error counts, and usage without raw child messages or tool payloads. Capability evidence, configured MCP server names, and the execution backend/binding/image are included. `review-group` contains a group ID and one bounded member result. Operational inspect/export documents are redacted and do not include raw messages, tool inputs/outputs, approval arguments, metadata, or full output text; `run-inspection.hierarchy` adds the redacted run tree. Tool-level repository-editing documents use their own schema version `1` and kinds such as `edit-proposal`, `patch-result`, `mutation-audit`, and `workspace-diff`; see [REPOSITORY_EDITING.md](./REPOSITORY_EDITING.md).

## JSON Lines

`--jsonl` is available for `run` and approval `resume`, and is mutually exclusive with `--json`. Every event line has `schemaVersion: 1`, `kind: "run-event"`, a monotonic `sequence`, and an event `type`. A separately projected compact `run-result` is emitted as the final sequenced line; it contains only run identity/status, step/tool counts, redacted approval identity, and child run identity/status. It omits output text, mutations, approval arguments, paths, scope, provider payloads, and configuration bindings.

The event projector allowlists safe fields. Text deltas and token usage are retained; tool IDs/names, approval IDs, status, step counts, compaction counts, and provider/model identity are allowed. Tool inputs/outputs, approval arguments, provider payloads, image content, full durable states/messages, raw errors, stacks, and telemetry metadata are omitted. Consumers must still treat model text as untrusted application data.

## Configuration schema

Resolved library configuration includes `schemaVersion: 4`, an explicit `allowedChecks` array, `storeBackend`, `scope`, parent `budget`, `compaction`, `requiredCapabilities`, optional `mcpConfigPath`, an `orchestration` object with profiles, child budget/timeout, and review concurrency, and a discriminated `execution` policy. The check default is `test`, `typecheck`, `lint`, and `build`; `--allow-check` or `ZHIVEX_HARNESS_ALLOWED_CHECKS` replaces that set. Execution defaults to `{ backend: "none" }`; an OCI policy records the runtime, image, allowed commands, and every resource ceiling. Passing a different explicit schema version fails before a model or tool can run. During `0.x`, a minor release may add a new schema version with a documented migration; patch releases remain compatible.

The default state directory is `<workspace>/.zhivex-harness/runs` and the default backend is scoped SQLite at `operations.sqlite`. Explicit external state directories are supported, but the workspace root, filesystem root, sensitive workspace paths, regular files, and symbolic-link targets are rejected before the run store is created. See [DURABLE_OPERATIONS.md](./DURABLE_OPERATIONS.md) for state migration and operations, and [EXTENSIBILITY.md](./EXTENSIBILITY.md) for capability, MCP, subagent, and review-group configuration.
