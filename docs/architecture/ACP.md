# Experimental ACP text sessions

The harness provides an experimental Agent Client Protocol v1 **subset** for an editor or other local client: initialization, new sessions, text prompts, one-time permissions and cancellation. It runs over JSON-RPC 2.0, one JSON message per line on stdio.

This is not full ACP conformance. Client-supplied stdio MCP servers require the explicit host integration below; the default CLI rejects them. Test compatibility with your editor before relying on it. The negotiation response marks the subset in `_meta.zhivex` and advertises `clientMcp` only when a host admission provider is attached.

## Launch

From a source checkout:

```sh
bun src/acp-cli.ts --workspace /absolute/project --provider openai --model YOUR_MODEL
```

After building:

```sh
node dist/acp-cli.js --workspace /absolute/project --provider openai --model YOUR_MODEL
```

Use existing host configuration flags and environment credentials. `--profile` loads an existing CLI profile. The service does not open interactive credential prompts. It writes only protocol messages to stdout; startup failures and help go to stderr. SIGINT, SIGTERM and closing stdin request cancellation and close the adapter and harness.

The client must wait for each setup response:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/absolute/project","mcpServers":[]}}
```

Use the returned `sessionId` in subsequent `session/prompt` requests with `prompt: [{"type":"text","text":"Your task"}]`. Completed assistant text arrives as a `session/update` notification before the prompt response. This implementation buffers output until the durable run completes; it does not stream individual tokens or tool updates.

## Permissions and cancellation

A durable pending approval produces a `session/request_permission` request. The client can select only `allow_once` or `reject_once`, or return a cancelled outcome. The adapter translates that decision using the pending approval's exact ID, digest and run revision. The existing harness verifies expiration, revision and file digests before execution. Approval requests expose the pending action as `toolCall.rawInput`; clients should render that action for review.

`session/cancel` is a notification. It stops an active run or pending permission request and returns the original prompt with `stopReason: "cancelled"`. Permission responses time out after 15 minutes and cancel the pending run. Closing the connection also cancels outstanding work. A cancellation does not undo effects already committed.

Only one prompt executes at a time per connection. Other simultaneous prompts receive a busy error. Unknown sessions, stale approvals and invalid permission choices cannot authorize operations.

## Supported boundary

- Host owns the workspace, provider, model, credentials, policies and tools. `session/new.cwd` must match the configured workspace.
- Text prompts only; no image, audio or embedded resources.
- Client stdio MCP only through explicit host rules and OCI admission. HTTP/SSE MCP, client filesystem operations and client terminals are unsupported.
- No session load/resume, model switching, modes, or authentication protocol. Durable sessions remain accessible through existing harness interfaces.
- Frames are limited to 1 MiB, prompts to 64 KiB, concurrent protocol handlers to 64 and sessions to 256 per connection. Oversized frames or handler floods terminate the connection and cancel work.
- A transport connection should belong to a single trusted local client. This is not an unauthenticated network service.

## Embedding

Create the existing `createHarnessClientAdapter(harness)`, then call `createAcpConnection(adapter, { workspace, notify, requestPermission })`. Pass decoded requests into `handle`; route returned responses back to the client. `requestPermission(params, signal)` should cancel its pending client request when the signal aborts. Call `cancelActive()` before closing a connection. The host remains responsible for `adapter.close()` and `harness.close()`.

`serveAcpStdio(adapter, { workspace, input, output })` supplies framing and permission-response correlation for Node readable/writable streams.

### Client MCP with host admission

The experimental `@zhivex-ai/harness/acp` export `createAcpMcpHost` composes the durable adapter and per-run isolated MCP lifecycle. Supply `harness` options with explicit tenant/user identity, `rules: AcpMcpHostRule[]`, an admission `authority`, immutable `provisionerImageId`, `hostId` and `resolveSecret`. Admission authorities come from `@zhivex-ai/harness/mcp/stdio/v1`; see [isolated MCP](MCP_STDIO.md).

Each rule matches a client's exact name, absolute command and arguments, and maps them to a host-owned OCI launch proposal. Image, executable, limits and tool allowlist belong to the host. `environmentBindings` explicitly maps client variables to admitted `ZHIVEX_MCP_*` names; their values are treated as sensitive. Configuration from the workspace cannot create these rules or grant admission.

Pass the returned `adapter`, `workspace` and `mcpSessionProvider` to `serveAcpStdio`, or to `createAcpConnection` with your transport callbacks. Always await `host.close()` in a `finally` block after transport shutdown. The provider is bound to that adapter; another adapter or a fabricated provider is rejected.

Registration is per ACP session. Before every run and approval continuation, the host snapshots the workspace, obtains fresh admission and starts the mapped servers in isolated Docker containers. Up to eight servers share the run while retaining independent receipts and tool namespaces. Tool effects still require client permission; admitting a server does not approve its tools. A partial startup failure closes previously started members. Cancellation while admission is pending prevents a late approval from launching a process.

Client descriptors live only in the host's memory and expire when it closes. This integration does not enable ACP session loading across restarts. A restarted client must create a new session. Durable effect journals and resource recovery still protect against uncertain outcomes; cancellation cannot undo effects already committed.

Protocol references: [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt lifecycle and cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn), [permissions](https://agentclientprotocol.com/protocol/v1/tool-calls).
