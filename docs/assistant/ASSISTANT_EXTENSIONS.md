# Assistant: configurable providers and composable modules

One instance per owner. This extension lives in Assistant on public Harness
APIs; it adds no multi-user support, chat-supplied code loading or automatic
plugin installation. Configuration is a local operator decision.

## OpenAI-compatible providers

Editable example: [compatible-calendar.json](../../packages/assistant/examples/compatible-calendar.json).
Replace endpoint/model and declare only verified model capabilities.
Store the secret in the variable named by `apiKeyEnv`, never in JSON.
After preparing the local Harness candidate and building Assistant:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-compatible" --owner local-owner --config /path/assistant.json --telegram-owner 123456789 --doctor
bun run --cwd packages/assistant start --directory "$HOME/.zhx-compatible" --owner local-owner --config /path/assistant.json --telegram-owner 123456789
```

Connect OAuth before starting, following the [pilot guide](ASSISTANT_PILOT.md),
using `--calendar-connect` without `--config`. Calendar configuration still
reads credentials from the existing variables. Calendar can be omitted
in favor of other modules or a general profile without tools.

The configurable provider requires:

- Explicit `kind: openai-compatible`, `baseURL`, `model` and `apiKeyEnv`.
- `apiMode: chat` for `/chat/completions`, or `responses` for `/responses`.
  No autodetection or silent fallback between protocols. The chosen mode
  overrides per-call options.
- `capabilities.streaming` and `capabilities.tools` set to true. `toolChoice`,
  `parallelToolCalls`, `structuredOutput`, `jsonMode` and `reasoning` are optional,
  false by default. This declaration enables unknown models in the SDK;
  it does not certify that the server actually fulfills the contract.
- HTTPS without embedded credentials, query or fragment. For a local HTTP
  server on `localhost`, `127.0.0.1` or `[::1]`, use `allowInsecureLocalhost: true`.
  Redirects are rejected. This enables neither remote HTTP nor endpoint discovery.

`--doctor` validates configuration and credential-variable presence without
calling the provider. It does not check actual capabilities. Transport uses
`@zhivex-ai/openai` and keeps tool results in envelope format.
Declaring compatibility does not grant OpenAI hosted tools.

Endpoint, protocol, model, credential reference and capabilities form a
digest bound to the durable profile. Changing them requires a new directory; changing
the secret value while keeping the reference allows rotation. The secret is not
included in that digest, instructions or diagnostics. A session with the
previous provider is not automatically migrated to the configurable provider.

The embedded API accepts `compatibleProvider` in `startAssistantHost`. It is mutually
exclusive with `engine.provider`, `engine.model` and `engine.modelInstance` to
prevent ambiguous configuration. The previous `--provider`/`--model` path remains available
if the file does not define a provider.

## Compose Calendar and other tools

[composed-modules.json](../../packages/assistant/examples/composed-modules.json) shows
Calendar and an HTTP MCP module. Replace endpoint, tools and credential reference
with values from your own integration. Run with `--config` and, if
JSON does not define a provider, the usual `--provider`/`--model` flags.
Do not combine `--config` with `--calendar` or Calendar OAuth actions in one command.
The independent Google mail/Drive module uses `--google-connect` with `--config`.

Each module declares identity/version, instructions, an exact tool list,
permissions and configuration. Server names must start with `id_`;
exposed tools are `server_tool`. Open catalogs,
collisions, alternative prefixes and MCP resources are unsupported in this first contract.
The file accepts `calendar`, `daily`, `google`, `github`, `web` and `mcp` types;
see [daily tools](ASSISTANT_DAILY_TOOLS.md) for the additional adapters and credentials.
A declarative MCP module uses
HTTP and `ZHIVEX_MCP_*` header references. It never loads JavaScript paths,
shell commands or packages supplied by a message.

Harness continues evaluating permissions, approvals, limits and cancellation. Declaring
`read`/`network` does not bypass review policy. Only trusted local read
adapters can use the existing read-annotation handling.

## Developer contract

Public Assistant exports:

- `AssistantModule`: `id`, `version`, `open(context)`.
- `AssistantModuleContext`: private instance directory, owner and
  explicit recovery flag. The module must keep its state separate
  and bind it to the owner; sharing a process does not constitute a sandbox.
- `AssistantModuleInstance`: stable binding without secrets, profile, MCP
  configuration, optional clients, shutdown; optionally tools requiring
  review details, their resolver and a read-only schedule source.
- `createCalendarModule(options)`: Calendar implementation with existing OAuth/operation
  journal, exact proposals, Telegram review and daily schedule.
- `createMcpModule(options)`: factory for HTTP or injected local clients. Local
  clients must be supplied by trusted code, together with an
  account/configuration `binding` and `close` if they own resources.

Embedded example:

```ts
const host = await startAssistantHost({
  directory, ownerId,
  compatibleProvider,
  modules: [createCalendarModule(calendarOptions), createMcpModule(notesOptions)]
});
```

The host sorts modules by ID, validates namespaces and combines profiles and clients.
If opening fails, it closes what it already opened; on shutdown, it attempts to close all
modules even if one fails. Modules receive capabilities through their adapters;
combining modules with `engine.agentProfile`, `engine.mcpConfiguration`
or `engine.mcpClients` is disallowed. Use another module to customize tools.

Review resolvers add details to the text bound to the Telegram review.
Declaring `reviewTools` without a resolver fails startup. In a manually embedded
bridge, pass `host.approvalDetails`, `host.reviewTools` and `host.agendaSource` to
preserve review and automation. The automatic host connects them itself.
Only one schedule source can exist for the daily summary; two fail at
startup to avoid implicitly selecting an account.

## Compatibility and recovery

`calendar: options` and `--calendar` are shortcuts for the Calendar module. Calendar alone,
without a configurable provider, preserves the previous v1 profile, tool names,
storage, binding and review. Its approval and recovery tests
still apply; reconnecting that account is unnecessary.

Adding/removing modules, changing versions/bindings or enabling a configurable
provider produces a different profile. The host rejects previous state;
use a new directory without deleting `host.json` or recycling approvals. Module
order does not change the profile. `preserveProfile` is reserved for trusted
compatibility adapters that already include their identity in the profile;
Calendar v1 uses it to preserve existing sessions.

The instance remains fixed to one owner, one bot and one private conversation.
For another person, use separate directory, credentials and bot. There is no isolation
between malicious modules executing in the same process: embedded extensions
are operator-trusted code.

## Validation and limitations

Offline tests cover Chat and Responses with unknown models, streaming, forced
mode, capability declarations, secrets excluded from bindings, invalid endpoints,
deterministic composition, collisions, cleanup after failures, configuration
without executable imports and rejected profile changes. Local HTTP servers
simulate both protocols during tool → approval → restart → resolution,
checking a single effect. Calendar is tested alongside a second module with
Telegram approval and event revalidation.

This does not certify commercial providers, specific local models or a
real MCP server. Before piloting each endpoint, run a controlled test
of streaming, tools, approval/restart, cancellation and errors. A successful
text response from the endpoint is insufficient.

Local acceptance 2026-11-10: installed consumer with 51 tests, 282 assertions,
0 failures; types, build and offline Node example passed. Architecture, contracts,
documentation and `git diff --check` passed. Unpublished Harness candidate 1.6.3,
SHA-256 `b199a154e3bfc95654df10cdc48f887f974098567f5c8bcb07646db106e04a1f`.
No real provider calls, publication or merge were performed.
