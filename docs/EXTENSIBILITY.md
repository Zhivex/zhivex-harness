# Extensibility and orchestration

Zhivex Harness `0.11.x` combines governed external tools and bounded multi-agent work with a public provider registry and explicit per-role model routing. Configuration schema is version `5`; registry selection, runtime model capabilities, routed child models, non-secret provider transport settings, project context, trusted hook identities, MCP, execution policy, budgets, and scope are bound into the durable harness fingerprint.

## Provider registry

Built-in registrations are Meta, Qwen, OpenAI, and Gemini. Each registration owns its descriptor, default model, credential names, capability/support labels, factory, and declarative diagnostics. The registry never dynamically imports provider code or returns credential/endpoint values from diagnostics.

Library callers can use `DEFAULT_PROVIDER_REGISTRY`, `BUILTIN_PROVIDER_REGISTRATIONS`, `createProviderRegistry`, or `DEFAULT_PROVIDER_REGISTRY.extend(...)`, then pass the registry to `resolveHarnessConfig`, `createProviderModel`, provider diagnostics, or `createHarness({ providerRegistry })`. Registration IDs, environment-variable names, defaults, diagnostics, and factories are validated before they become selectable.

The coordinated stable SDK batch pins `@zhivex-ai/agents@1.10.0`, `@zhivex-ai/core@1.24.0`, `@zhivex-ai/meta@0.2.8`, `@zhivex-ai/qwen@0.15.3`, `@zhivex-ai/openai@0.13.6`, and `@zhivex-ai/gemini@0.12.3`. These exact versions were selected from npm `latest`. Stable SDK publication does not replace Harness release-bound certification. Qwen `0.11.x` normalizes missing, placeholder, and continuation tool-call identifiers inside the adapter; Harness retains its deterministic provider-boundary normalizer as defense in depth until the exact candidate passes the complete release-bound representative matrix. A Core override keeps one runtime contract identity across every adapter, while Core `1.13.0` corrects compaction usage accounting and interaction-group retention. OpenAI `0.11.2` preserves synthetic assistant history in Responses, so the harness no longer requires its compaction transport or accounting workarounds.

OpenAI is based on the GPT-5.6 family: `gpt-5.6-luna` is the default, with `gpt-5.6-terra` and `gpt-5.6-sol` available through `--model`. Availability remains organization-dependent while the upstream family is in limited preview, and the adapter uses the Responses API by default.

Gemini still defaults to `gemini-3.6-flash`, uses `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`, and accepts optional `GEMINI_BASE_URL`. Adapter `0.11.0` adds modeled Gemini 3.7 and media/realtime surfaces, but the default and support level do not change implicitly. Gemini remains provisional until proposal/approval/restart, delegation, mixed routing, and OCI execution pass the credentialed Harness live matrix; adapter-level evidence alone does not make the Harness integration certified.

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
      "headerEnv": { "x-api-key": "ZHIVEX_MCP_DOCS_API_KEY" },
      "callToolTimeoutMs": 30000,
      "maxOutputBytes": 262144
    }
  ]
}
```

Every server requires a non-empty tool or exact-resource allowlist and permission set. Tool discovery is paginated and bounded. Tool names are prefixed with `<server>_` unless an explicit safe prefix is supplied. Configuration contains environment-variable names rather than credential values; diagnostics and fingerprints never include resolved header values. Credential variables must use the dedicated `ZHIVEX_MCP_*` namespace, and HTTP authentication is limited to the canonical `authorization` and `x-api-key` headers so a workspace file cannot select unrelated process credentials or arbitrary outbound headers.

The legacy built-in transport supports HTTPS and loopback HTTP; the opt-in SDK transport requires HTTPS. Redirects, URL credentials, unsafe configurable headers, oversized configuration, symlinked configuration, and configuration outside the workspace are rejected. `stdio` is intentionally unavailable because spawning an MCP server is process execution; it remains deferred until the enforced execution environment in `0.6.x`.

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
| `tester` | Focused verification | Read-only inspection plus approved repository package-manager checks |
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

## Per-role model routing

Route selected profiles without changing the parent model:

```bash
zhx run \
  --provider openai \
  --route explorer=qwen \
  --route reviewer=gemini:gemini-3.6-flash \
  "implement the change and review it"
```

The grammar is `<profile>=<provider>[:<model>]`; supported profiles are `explorer`, `implementer`, `tester`, and `reviewer`. Omitting a model uses the provider registration's default. Duplicate roles, unknown providers, invalid model text, missing credentials, and capability mismatches fail before the parent run starts. Providers are instantiated only for selected routes.

The resolved route plan is persisted without credentials in CLI resume metadata and instantiated child capabilities participate in the harness fingerprint. Changing a route never mutates or resumes a run under another model; the interactive console starts a new session turn.

## Routing limits

- There is no automatic failover inside a run and no provider change while an approval is pending.
- `--max-cost-usd` with any route is rejected because `0.11.x` has one operator-supplied price pair, not pricing per model/run.
- Routing does not infer speed, quality, price, or a “best” provider; presets remain deferred until the model catalog contains reliable evidence.
- The CLI registry is static. Applications may inject a validated registry through the TypeScript API, but configuration files cannot load arbitrary provider modules.
- Cross-provider console context uses deterministic redacted compaction and omits tool/provider payloads; it is a portable summary, not a byte-identical transcript handoff.

## Budgets and cancellation

### Application-owned read contracts (Beta)

For exact read-only tasks, applications can provide `delegationContracts` to
`createHarness`. Each enabled profile must have one contract; currently reviewer
and explorer are supported. The parent sees only delegation tools accepting
`{ taskId }`. Harness resolves that ID to the trusted prompt; model-generated
`prompt`, `system`, unknown IDs and extra fields are rejected before delegation.

```ts
const harness = await createHarness({
  provider: "qwen",
  workspace,
  subagentProfiles: ["reviewer"],
  subagentMaxSteps: 2,
  subagentMaxToolCalls: 1,
  delegationContracts: [{
    taskId: "review-target",
    profile: "reviewer",
    prompt: "Review target.txt for correctness.",
    allowedReadPaths: ["target.txt"],
    requiredOutput: "REVIEW_COMPLETE"
  }]
});
await runHarness(harness, { prompt: 'Delegate taskId "review-target" and summarize the result.' });
```

Contract children expose only `read_file`, with exact canonical relative-path
checks before execution and the normal filesystem protections. They receive
explicit budgets and do not inherit broad repository-audit instructions. The
child must perform a successful allowed read and return `requiredOutput`; the parent cannot complete successfully
without completed, accepted children for all configured contracts. The token
checks a protocol condition, not the semantic correctness of the review.

Contracts are copied at construction and bound into parent/child fingerprints;
resuming under a different contract is rejected. This mode retains SDK child
linkage, usage, cancellation and persistence. It does not retry invalid proposals
or increase a budget automatically. Callers without contracts keep the existing
general-purpose delegation API, including approval-gated mutation profiles; the
contract guarantees do not apply to that legacy mode. CLI configuration does not
yet expose these application-owned contracts. The live orchestration smoke uses
this mode, retains the one-tool budget and verifies both durable states on reopen.

The SDK next batch fixes failed-child usage/linkage and OpenAI function receipt
serialization. Harness retains the compatible OpenAI envelope middleware. Native
Responses fixtures must label both their original call and result consistently.
Strict applications may also supply `toolNames`, an explicit subset of the
catalog. Unknown tools are rejected, instructions are rendered for the selected
tools, and the selection is fingerprint-bound. This is trusted application
configuration, not a capability granted to the model. Repair mode does not accept
a subset because its controller requires its own tools. The base live smoke
selects only `propose_edits` and `apply_patch`, retaining every approval, restart,
exact-effect, journal and final-marker assertion.

The Stable signature baseline changes only for the additive optional
`CreateHarnessOptions.delegationContracts` and `toolNames` fields and the
`createHarness` signature that includes them; existing callers remain compatible.

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

- The legacy MCP transport implements bounded JSON-RPC over Streamable HTTP response forms; it does not support OAuth discovery, server-initiated sampling, roots, subscriptions, elicitation, or arbitrary SSE reconnection.
- MCP prompt-injection detection is a safety filter, not a proof that remote content is trustworthy.
- Parallel review groups have a durable shared parent identifier, but the group itself is not a standalone persisted agent state.
- With `execution=none`, subagents share the host process and workspace and are policy boundaries rather than OS isolation. With `execution=oci`, they inherit the same acquired snapshot and environment authorization; this does not turn the local container runtime into a VM.
- Generic host shell, `stdio` MCP, network-enabled OCI policies, and remote workers remain unavailable. The `0.6.x` OCI policy rejects all MCP before discovery rather than executing an undeclared client outside the acquired boundary.
- Provider-specific orchestration behavior requires date-bound live certification and is separate from deterministic implementation evidence.

## Allowlisted MCP text resources

MCP servers may expose text resources as well as tools. Add `includeResources` with exact URIs to the existing MCP server configuration:

```json
{
  "schemaVersion": 1,
  "servers": [{
    "name": "docs",
    "transport": "http",
    "url": "https://mcp.example.com/rpc",
    "includeResources": ["docs://project/architecture"],
    "permissions": ["read", "network"]
  }]
}
```

`includeTools` may be omitted or empty only when resources are explicitly allowlisted. Tool-only configurations keep their previous normalization and fingerprint. Discovery uses MCP `resources/list`; a server must list every requested URI within the configured `maxListPages`, `maxListedTools` (also the resource item cap), `listToolsTimeoutMs`, and per-response `maxOutputBytes` bounds. HTTP servers must declare the `resources` capability during initialization. Existing HTTPS/loopback restrictions, credential-header allowlist, no-redirect behavior, session negotiation and JSON-RPC response matching apply unchanged.

The harness exposes `<toolNamePrefix>read_resource`, accepting exactly one allowlisted URI. Every read requires approval, including a custom read-only server with trusted tool annotations. Resource metadata carries the MCP origin and read/network permissions, so the scheduler cannot treat these calls as trusted workspace reads. Contents are fetched only after approval, limited by `callToolTimeoutMs` and `maxOutputBytes`, and returned as untrusted evidence. The reader rejects substituted URIs, probable prompt injection, binary blobs and malformed content. URI templates, wildcard grants, subscriptions and automatic context injection are not supported. `file:` URIs are sent to the MCP server; the harness does not open them as local files.

Injected clients can implement the optional `listResources` and `readResource` methods on `HarnessMcpResourceClient`; existing tools-only `McpClient` implementations remain compatible. Custom operations receive abort signals and are bounded even when they ignore cancellation. Applications remain responsible for stopping any background work in their injected implementation after cancellation. The existing prohibition on host MCP clients under OCI execution also covers resource servers.

Protocol reference: [MCP resources, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/resources). The resource tools do not expose resource templates, prompts, or binary resource rendering. OAuth is available only through the explicitly selected SDK transport and a trusted host provider, described below.
## Application tool policies (Experimental)

`createHarness({ toolPolicy })` accepts trusted application-owned declarative rules
with stable IDs, exact tool names, optional exact paths, reasons and `allow`,
`ask_user` or `deny`. The most restrictive matching decision wins. An allow rule
cannot remove existing approval requirements, enable a missing tool or weaken
filesystem/OCI policy. The policy also wraps tools supplied to named child profiles.

Path rules require a trusted `toolPolicyPaths(toolName, input)` resolver plus a
stable `toolPolicyPathsVersion`. Its version and the policy digest bind durable
resume. SDK approval flags are static, so a path-scoped ask rule conservatively
requires approval for the entire named tool. Such tools are never parallel reads.
`onToolPolicyDecision` receives the applied rule IDs and reason. Repository manifests
cannot register these callbacks. Existing lifecycle hooks remain available.

```ts
const harness = await createHarness({
  toolPolicy: { schemaVersion: 1, rules: [{
    id: "review-deletes", tools: ["quarantine_file"], decision: "deny",
    reason: "This application does not permit removing files."
  }] }
});
```

See [ACP](ACP.md) for the experimental text-session client adapter and
[workspace checkpoints](WORKSPACE_CHECKPOINTS.md) for reviewed restoration and
recovery. OAuth credential UI and process-based MCP remain unavailable. The
explicit SDK HTTP path below supports host-owned OAuth providers.


## SDK HTTP transport and host-owned OAuth (experimental)

Existing configurations keep the MCP `2025-06-18` HTTP transport, including loopback HTTP. Opt into the SDK's reusable Streamable HTTP client with `protocolVersion: "2025-11-25"` on an HTTPS server. The version is included in the durable configuration fingerprint; there is no automatic downgrade or retry after a potentially effectful call.

```json
{
  "schemaVersion": 1,
  "servers": [{
    "name": "docs",
    "transport": "http",
    "protocolVersion": "2025-11-25",
    "url": "https://mcp.example.com/rpc",
    "includeTools": ["lookup"],
    "includeResources": ["docs://project/architecture"],
    "permissions": ["read", "network"]
  }]
}
```

The selected SDK client handles session negotiation, capability checks, bounded JSON/SSE responses, protocol validation and typed resource requests. The harness retains exact tool/resource allowlists, text-only resource validation, untrusted-content handling, interrupt approvals and OCI restrictions. Every destination is pinned to the configured endpoint and redirects are prohibited. A host `destinationPolicy` can further restrict DNS/IP/tenant access; it cannot permit another server. DNS resolution enforcement remains the host deployment's responsibility. The harness propagates its per-operation deadline into the SDK's initialization fetch and host credential provider as well as the caller-facing operation.

For OAuth, construct `createMcpOAuthProvider` from `@zhivex-ai/core/mcp-http` in trusted host code. The SDK implements PKCE, resource/issuer binding and token refresh. The host supplies the issuer/client ID, approved endpoints, token store and authorization callback flow. Workspace JSON cannot define an OAuth issuer, token store, browser action or raw credential.

Pass that SDK provider to `createHarness` as `mcpHttpOptions: { docs: { auth: oauthProvider, destinationPolicy } }`, or directly to `createHarnessMcpTools(config, { httpOptions: { docs: { auth: oauthProvider, destinationPolicy } } })`. An existing host can instead inject `createHttpMcpClient(server, env, fetch, { auth: oauthProvider })` through `mcpClients`. The provider object and tokens are never added to persisted configuration. An OAuth provider cannot be combined with a static `authorization` header; the dedicated `x-api-key` environment header remains available where required.

Authentication failures are surfaced with sanitized SDK error codes. The harness does not automatically launch login, select an issuer from untrusted metadata, or retry `tools/call`. An `INDETERMINATE` result means an external effect may have happened: reconcile it before retrying. Host OAuth injection is unavailable on the legacy protocol path. The SDK supports additional prompt/template APIs, but this harness deliberately exposes only its configured tools and exact text resources.
