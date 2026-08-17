# Extensibility and orchestration

Zhivex Harness `0.5.x` adds governed external tools and bounded multi-agent work without adding a generic shell or weakening the workspace contract. Configuration schema version `3` binds capability requirements, MCP policy, subagent profiles, child budgets, and scope into the durable harness fingerprint.

## Capability gate

Every run requires streaming and callable-tool support by default. Add explicit requirements with repeatable CLI flags:

```bash
zhivex-harness run \
  --require-capability tools \
  --require-capability structured-output \
  "produce the requested change"
```

Supported requirement names are `streaming`, `tools`, `structured-output`, `parallel-tools`, `reasoning`, and `web-search`. The instantiated model is inspected before persistence or model execution. An incompatible model fails before entering MCP or subagent discovery. Library callers can use `inspectHarnessModelCapabilities`, `assertHarnessModelCapabilities`, and `selectHarnessModel` for deterministic candidate routing.

Capability acceptance is model-specific. A provider label or compatible endpoint does not imply every model supports the requested contract.

## Declarative MCP configuration

Pass a regular JSON file inside the canonical workspace:

```bash
zhivex-harness run --mcp-config examples/mcp-config.json "consult the approved documentation tool"
```

The schema is versioned independently:

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "name": "docs",
      "transport": "http",
      "url": "https://mcp.example.com/rpc",
      "includeTools": ["search_docs", "read_page"],
      "permissions": ["read", "network"],
      "headerEnv": { "x-api-key": "DOCS_MCP_API_KEY" },
      "callToolTimeoutMs": 30000,
      "maxOutputBytes": 262144
    }
  ]
}
```

Every server requires a non-empty tool allowlist and permission set. Tool discovery is paginated and bounded. Tool names are prefixed with `<server>_` unless an explicit safe prefix is supplied. Configuration contains environment-variable names rather than credential values; diagnostics and fingerprints never include resolved header values.

The built-in transport supports HTTPS and loopback HTTP. Redirects, URL credentials, unsafe configurable headers, oversized configuration, symlinked configuration, and configuration outside the workspace are rejected. `stdio` is intentionally unavailable because spawning an MCP server is process execution; it remains deferred until the enforced execution environment in `0.6.x`.

Library callers can inject a custom `McpClient`. Trusted read-only annotations are accepted only for an explicitly injected custom transport whose sole declared permission is `read`. HTTP always declares `network` and therefore always pauses for operator approval, even when a server claims a tool is read-only.

## MCP result boundary

MCP descriptions and results are untrusted. The harness:

- bounds discovery pages, discovered tools, time, and response bytes;
- validates declared input and structured-output schemas through the SDK MCP registry;
- propagates abort signals, timeout intent, and idempotency keys;
- rejects common prompt-injection directives before they enter model context;
- records server permissions and risk in tool metadata;
- promotes network, write, or external-side-effect calls to durable interrupt approval.

The injection filter is deliberately conservative and may reject legitimate security documentation containing imperative attack text. Use a separate trusted preprocessing boundary if that content must be analyzed; do not disable the harness boundary for an untrusted server.

## Named subagent profiles

Four profiles are enabled by default:

| Profile | Purpose | Tools |
| --- | --- | --- |
| `explorer` | Repository discovery and evidence | Read-only workspace inspection |
| `implementer` | One bounded implementation task | Workspace tools; mutations remain approval-gated |
| `tester` | Focused verification | Read-only inspection plus approved Bun checks |
| `reviewer` | Independent correctness/security review | Read-only diff and audit inspection |

Select an explicit subset with repeatable flags:

```bash
zhivex-harness run \
  --subagent explorer \
  --subagent reviewer \
  "analyze the persistence boundary"
```

The parent receives `delegate_explorer`, `delegate_implementer`, `delegate_tester`, and `delegate_reviewer` tools for the enabled profiles. Delegation is model-directed only when the parent invokes one of these tools. A child inherits the canonical workspace, durable scope, store, memory, cancellation boundary, approval policy, and telemetry observer. Each child has its own harness fingerprint, lease, state limit, timeout, step/tool/error/token budget, and run ID.

Child mutations and checks do not inherit an approval automatically. A paused child approval is promoted to the parent as `kind: "subagent"`; approving the parent resumes the same durable child checkpoint. Completed child tools are protected by the shared exactly-once journal.

## Budgets and cancellation

Defaults per child are 8 steps, 16 tool calls, 3 tool errors, 30,000 input tokens, 8,000 output tokens, 36,000 total tokens, and a five-minute timeout. Override them with the `--subagent-*` options or matching `ZHIVEX_HARNESS_SUBAGENT_*` variables.

The child enforces its independent budget with `includeChildRuns: false`. The parent budget retains `includeChildRuns: true`, so child consumption also counts against the aggregate ceiling. Token ceilings are enforced after each provider step to avoid reserving the entire parent allowance again after a child has consumed tokens; measured usage can cross a ceiling by one provider step.

Use cascade cancellation to finalize a parent and every persisted child:

```bash
zhivex-harness runs cancel <parentRunId> --cascade --final --reason "superseded"
```

## Application-owned parallel review

`review` runs deterministic application-owned parallel review instead of asking a model to decide the topology:

```bash
zhivex-harness review \
  --reviewer explorer \
  --reviewer reviewer \
  --json \
  "review the durable approval boundary"
```

Only the read-only `explorer` and `reviewer` profiles are accepted. The default concurrency ceiling is two and the hard maximum is four. Each member is a durable child with a shared group parent identifier. A member failure is reported without silently discarding the other independent result.

## Progress and JSON

Human terminal mode reports child start and finish telemetry. `run-result` JSON includes capability evidence, configured MCP server names, enabled profiles, child run IDs/status/usage, promoted approval identity, and the aggregate budget. `review-group` JSON includes the group ID and one bounded result per member. `runs inspect` adds the redacted hierarchical trace while continuing to omit raw messages, tool inputs/outputs, approval arguments, metadata, and full output text.

## Migration from 0.4.x

- Configuration schema `2` becomes schema `3`; remove a pinned `schemaVersion: 2` or migrate it to `3` after reviewing capability, MCP, and subagent defaults.
- Named subagents are enabled by default. Pass an empty `subagentProfiles` array from the library, or set `ZHIVEX_HARNESS_SUBAGENTS=` for a parent-only run.
- The harness fingerprint now includes required capabilities, child policy, profile selection, and normalized MCP configuration. A paused `0.4.x` run with an existing fingerprint must be completed with the `0.4.x` binary; it is not silently rebound to `0.5.x`.
- Existing scoped SQLite data remains readable. No database rewrite is required.
- MCP configuration must be placed inside the workspace and must not contain raw secrets.

## Known limits

- The built-in MCP transport implements bounded JSON-RPC over Streamable HTTP response forms; it does not support OAuth discovery, server-initiated sampling, roots, subscriptions, elicitation, or arbitrary SSE reconnection.
- MCP prompt-injection detection is a safety filter, not a proof that remote content is trustworthy.
- Parallel review groups have a durable shared parent identifier, but the group itself is not a standalone persisted agent state.
- With `execution=none`, subagents share the host process and workspace and are policy boundaries rather than OS isolation. With `execution=oci`, they inherit the same acquired snapshot and environment authorization; this does not turn the local container runtime into a VM.
- Generic host shell, `stdio` MCP, network-enabled OCI policies, and remote workers remain unavailable. The `0.6.x` OCI policy rejects all MCP before discovery rather than executing an undeclared client outside the acquired boundary.
- Provider-specific orchestration behavior requires date-bound live certification and is separate from deterministic implementation evidence.
