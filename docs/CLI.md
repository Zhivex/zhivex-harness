# CLI contract

Zhivex Harness `0.2.x` is Bun-first and exposes a human terminal interface plus versioned JSON documents for automation.

## Commands

```text
zhivex-harness run [options] "task"
zhivex-harness chat [options]
zhivex-harness providers [--json]
zhivex-harness doctor [options] [--json]
zhivex-harness resume [options] <runId> --approve|--deny
zhivex-harness --version
zhivex-harness --help
```

`doctor` is local and makes no provider request. It checks the Bun version, workspace, Git, supported package scripts, state-directory safety, provider credential presence, endpoint shape, and provider configuration without returning secret or endpoint values.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully. |
| `1` | Runtime, provider, or agent failure. |
| `2` | Invalid CLI usage. |
| `3` | `doctor` found a blocking configuration problem. |

Agent results with status `failed` or `timed_out` return `1`. A paused approval is a valid durable result and does not imply a runtime failure.

## JSON schemas

All structured documents include:

```json
{
  "schemaVersion": 1,
  "kind": "providers | doctor | run-result"
}
```

Additive fields may appear within schema version `1`. Removing a field, changing its meaning, or changing a field type requires a new schema version and a migration note. Human-readable output is not a machine contract.

Provider diagnostics include credential variable names and boolean presence only. Endpoint diagnostics include validation booleans only. Neither contract contains credential values or endpoint URLs.

## Configuration schema

Resolved library configuration includes `schemaVersion: 1`. Passing a different explicit schema version fails before a model or tool can run. During `0.x`, a minor release may add a new schema version with a documented migration; patch releases remain compatible.

The default state directory is `<workspace>/.zhivex-harness/runs`. Explicit external state directories are supported, but the workspace root, filesystem root, sensitive workspace paths, regular files, and symbolic-link targets are rejected before the run store is created.
