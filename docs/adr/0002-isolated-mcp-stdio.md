# ADR 0002: Host-admitted MCP stdio inside OCI

Status: proposed for implementation review (HAR-HU-46), 2026-09-29.
This is a design contract and acceptance fixture specification. It does not
activate stdio, change configuration schema 1, or claim isolated execution passed.

## Evidence and compatibility baseline

- `src/integrations/mcp.ts`: configuration accepts `http`/`custom`; custom clients
  require explicit host injection. Tool/resource allowlists, output bounds and
  durable approvals already exist.
- `src/client/acp.ts`: client `mcpServers` must be empty. Preserve that rejection
  until host admission and isolated launch are implemented together.
- `src/execution/execution-environment.ts`: OCI enforces network denial, read-only
  root filesystem, unprivileged user, dropped capabilities, bounded resources,
  private workspace volume and optional read-only dependencies. Its adapter has
  finite `run`/`runBatch`, not an interactive stdio process lease. All MCP is
  currently rejected with OCI enforcement before discovery.
- Installed `@zhivex-ai/core` 1.26.0 exposes `McpClient`, call options with abort,
  timeout/idempotency key, and an HTTP transport; no executable stdio factory was
  found in this dependency. The control-plane transport enum is not an executor.

MCP stdio uses UTF-8 newline-delimited JSON-RPC on stdin/stdout; stderr is a
separate diagnostic stream. Preserve message correlation and initialization.
Source: [MCP transport specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
The proposed initial protocol is explicitly 2025-11-25; unsupported negotiation
fails before discovery. HTTP's existing version behavior remains unchanged.

## Boundary and authority

Choose the enforced OCI boundary, initially Docker with the existing platform
support policy. A future backend must pass the same fixtures before advertising
support. A process on the host, a filtered environment, a permission prompt or an
SDK transport alone is not this boundary. Missing Docker, attestation, resource
limits or interactive capability means rejection, never host fallback.

A client sends a *proposal*, not an executable command. Proposed fields are:
`schemaVersion: 1`, server ID, immutable image digest, absolute in-image executable,
argv array, protocol version, relative snapshot working directory, explicit tool
and resource allowlists, permissions, environment literals, secret references,
resource/deadline limits and snapshot identity. Unknown fields are rejected.
Host paths, shell command strings, PATH search, package installation at launch,
mutable image tags and interpreter flags that load host configuration are denied.
These are proposed host API fields, not accepted workspace configuration today.

The host validates and presents executable/argv, image, filesystem scope, allowed
tools, environment names, secret reference names and limits for explicit launch
admission. No image pull, subprocess, initialize or discovery occurs merely from
parsing configuration, opening a client session or importing a module. The host
may admit an already provisioned image only; image provisioning is a separate
host operation. The host issues an opaque single-use admission receipt bound to
principal, tenant/scope, workspace snapshot digest, session, full normalized
proposal digest, image identity, policy version and expiry. Client booleans,
model text and tool annotations cannot manufacture that receipt.

Admission checks are repeated immediately before launch. Configuration changes,
workspace/scope changes, expired receipts and reuse invalidate it. Raw receipt
capabilities are not serialized to the client or exported in run histories.
Launch admission grants no approval to call mutating tools. Existing per-call
approval remains required; server metadata cannot expand admitted permissions.

## Execution policy v1

| Surface | Required enforcement |
| --- | --- |
| Startup | Acquire isolated execution lease and private snapshot, attest image/policy, consume admission once, then start exact executable/argv without shell. Failure removes partial resources. |
| Environment | Start empty except host-fixed HOME/TMPDIR inside bounded tmpfs and minimal runtime locale. Admit explicitly named literal values. Reject injection/control variables including PATH, NODE_OPTIONS, loader paths and runtime preload flags. Never inherit process.env. |
| Secrets | None by default. Host resolves admitted opaque references immediately before launch and injects only named values in the isolated process environment. Missing/expired references fail closed. No secret values in argv, proposal, fingerprints, receipts, logs or fixtures. Redact stdout-derived diagnostics as well as stderr. The admitted server can read its granted secrets; isolation does not make it trustworthy. |
| Network | Deny all egress/ingress, DNS and host/metadata access using OCI network none. No domain allowlist or proxy exception in v1. A server requiring network is unsupported. |
| Filesystem | Read-only image root; private snapshot at /workspace; bounded tmpfs; optional declared read-only dependency tree. No host home, repository bind mount, credential directory, Docker socket or arbitrary volume. Read-only permission mounts workspace read-only. Write permission affects only private snapshot. |
| Publication | Isolated writes never mutate the host tree. Capture reviewed patch, validate preimages/path rules and obtain separate durable host approval before importing, using the existing execution delivery contract. |
| Resource limits | Host hard maxima intersect requested limits: memory, CPU, pids, workspace/write bytes, tmpfs, output and elapsed runtime. No client may increase a host limit. Reject unsupported enforcement. |
| Lifetime | One isolated server per admitted session; no cross-tenant reuse. No auto-restart or adoption after host restart. Reconnect requires fresh launch admission. |

The reusable execution policy remains authoritative; this proposal cannot weaken
its limits. SDK `McpClient` describes messages, not confinement. Bridge the admitted
process streams into an internal client implementing listTools/callTool and the
resource subset already allowed by Harness. Keep HTTP and existing injected
custom clients unchanged in non-OCI runs. Do not reinterpret arbitrary injected
clients as isolated. Preserve allowlists, bounded pagination, schema validation,
redaction and approval wrappers above the bridge.

## Lifecycle, framing and uncertain effects

Proposed lifecycle: proposed -> admitted -> starting -> initializing -> ready ->
closing -> closed, with failed terminal outcome at any nonterminal stage. Bind all
requests and audit events to admission and process-lease identities. Suggested
host defaults: start 10 s, initialize 10 s, existing list 5 s/call 30 s bounds,
maximum session 10 min, graceful stop 2 s followed by forced boundary removal.
These are finite absolute deadlines; receiving partial output cannot extend them.
Use the smaller host/request deadline and propagate AbortSignal. Limit in-flight
requests to one initially, 1 MiB UTF-8 frame and 64 KiB retained redacted stderr;
retain existing lower per-tool output limits. Apply backpressure with bounded
queues. Oversized/incomplete frames, invalid UTF-8/JSON, duplicate or unknown
response IDs and stdout log contamination close the transport with a typed error.
Server-initiated execution/sampling/elicitation requests are unsupported and must
not invoke host capabilities. Notifications cannot grant permissions.

On cancellation or timeout: stop new calls, best-effort protocol cancellation,
close stdin, terminate the isolated process tree, force-remove its boundary after
grace, reap handles and release leases. EOF/exit fails outstanding calls. A crash
or timeout after dispatch leaves a possibly effectful call `outcome_unknown` in
host audit until reconciled. Reconciliation requires confirmed resource cleanup, an explicit host-authorized decision bound to the journal revision and an evidence digest. Preserve the prior uncertain status and keep the original call key unreplayable; a future call requires a new admission and approval. Never replay it automatically, even with an SDK
idempotency key. Read-only calls are not automatically retried in v1 either.
Do not report cleanup success until the runtime confirms resources are gone;
otherwise retain a cleanup-required record for scoped orphan reconciliation.

The current finite OCI adapter cannot fulfill this contract unchanged. A future
optional interactive capability must expose attested launch, bounded stdin writes,
stdout/stderr reads, exit observation and idempotent close; acquisition owns the
lease. Missing capability fails before spawn. Do not implement stdio by calling
host spawn from `createHarnessMcpTools` or by buffering a never-ending `run`.

## Threats and review gates

| Threat | Control and evidence required |
| --- | --- |
| Client commands run during session creation | Reject before admission; zero host/container processes and zero discovery calls. |
| TOCTOU, swapped image/argv or replayed admission | Digest/identity recheck at launch; receipt scope/expiry/single-use tests. |
| Secret/environment exfiltration | Empty inherited environment, restricted references, network denial, redacted audit; canary checks inside/outside boundary. |
| Filesystem escape and host mutation | No bind mounts, no-follow snapshot/import rules, resource limits and reviewed publication; symlink/traversal fixtures. |
| Tool metadata or prompt injection escalates authority | Independent host policy and per-call approvals; untrusted descriptions/results remain data. |
| Hung/forking/noisy process | Absolute deadlines, frame/queue/stderr/resource bounds and whole-boundary cleanup. |
| Cross-scope reuse or uncertain effect replay | Scoped leases/admission; persisted unknown outcome; no reconnect/restart replay. |
| False isolation claim | Real OCI and installed-package gates, not mocks alone; unsupported backend denied. |

The [fixture catalogue](../fixtures/mcp-stdio-contract-v1.json) specifies positive
and negative acceptance before implementation. Every case is currently
`specified_not_executed`, not a passed test. Implementation must supply observations
for launch counts, process identity, network probes, host/snapshot digests, resource
cleanup and sanitized errors as specified. A fake runtime may prove host admission
logic; only real OCI can establish filesystem/network/process enforcement.
Existing MCP/ACP regression tests protect today's rejection boundary. Delivery
requires Node and Bun installed consumers plus real supported OCI execution,
including crash/cancel/orphan fixtures, before changing support/ACP capabilities.
