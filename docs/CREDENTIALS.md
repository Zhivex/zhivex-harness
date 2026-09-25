# API keys

## Interactive setup

Start `zhx`. After choosing your provider/model, the console uses an environment
key if present, otherwise a key for this CLI session, otherwise the system keychain.
If none is available, it offers:

- **Save or replace in system keychain**: persists across CLI restarts.
- **Use only for this CLI session**: stays in process memory and is forgotten on exit.
- **Remove saved and temporary key**: requires a separate confirmation.
- **Back**: cancels setup without sending a provider request.

API key entry is hidden and never enters prompt history. Paste inserts a draft;
a separate Enter submits it. Ctrl+C cancels. Whitespace, multiline input, control
characters and keys longer than 8192 characters are rejected.

Open `/menu` → **Credentials**, or use `/credentials`, to manage keys by provider.
Finish or deny unresolved work before changing credentials. Updated/deleted keys
are respected before the next new task. Removing a key does not revoke it at the
provider; use the provider dashboard for revocation.

## Storage

macOS uses Keychain. Linux explicitly requires Secret Service (for example an
unlocked GNOME Keyring or compatible service with a D-Bus session). The optional
`@napi-rs/keyring` native binding may be unavailable on a particular installation.
A locked, unavailable or unsupported backend never falls back to a plaintext file
or kernel keyring. The recovery menu lets you explicitly choose temporary use,
retry after unlocking storage, or cancel. A failed save never changes storage mode
automatically; temporary recovery asks for the key again.
`ZHIVEX_HARNESS_CREDENTIAL_STORE=disabled` disables native keychain access, useful
for isolated tests and installations where keychain use is prohibited.

The CLI uses its own `ai.zhivex.harness.cli` service with separate provider accounts.
It does not read, replace or delete Desktop's keys. Windows native support is still
outside the CLI support contract; adding this binding does not certify Windows.

## Environment and automation

Environment keys take precedence over saved and temporary keys, including provider
aliases. The CLI reports that precedence when managing a key while an environment
key exists. For Qwen, explicitly configuring a connection selects its managed credential for the current CLI session, overriding Qwen shell settings. On a new launch, environment keys take precedence again.

One-shot commands (`run`, `review`, `resume`), `providers`, and service connections
retain their existing environment/host-owned behavior: they never prompt for keys
or access the system keychain. Use the interactive console to resume a
conversation with a managed key.

`doctor` checks the selected provider using environment credentials first, then the
system keychain, including with `--json`. It never asks for an API key, writes a key,
or contacts the provider. The OS may require unlocking secure storage. It reports
missing, unavailable, or endpoint-blocked managed credentials distinctly. Its
selected-provider check includes the credential source and an explicit
`accountAccess: "not-checked"`; the provider inventory still describes environment
configuration. Temporary keys belong to their running console and cannot be seen
by a separate doctor process.

## Boundaries

Keys are kept outside profiles, repositories, run metadata and chat history. Managed
keys are passed only to provider model clients, not to `process.env`, MCP or command
execution environments. Do not paste a key into a normal conversation.

Managed keys for other providers require default endpoints. Qwen keys are bound to
an explicitly selected service and region. When shell endpoint settings conflict,
the console offers to use the saved destination for this session or cancel. It never
sends a managed key to an arbitrary shell-defined endpoint. Custom endpoints still
require explicit environment credentials.

## Qwen interactive setup

Open `/credentials` → Qwen → save or temporary → Standard API or QwenCloud Token
Plan. Standard API asks for region and, where needed, a workspace ID. Then enter
the hidden key. Service/region/workspace and key are stored together in the system
keychain (or only in memory for temporary use); no key enters the profile.
Existing raw Qwen keychain entries retain the historical Singapore API destination.
Changing service requires entering the matching key; the CLI does not infer it
from a key prefix. Cancellation preserves the previous connection.

Select the model with `/model`, then use `/connection` for an optional small,
potentially billable request. It sends no repository content or tools, allows 16
output tokens, disables retries, and times out after 15 seconds. A successful test
only verifies access to that model. Setup itself does not validate account access.
Regional destinations follow the [official Model Studio region documentation](https://www.alibabacloud.com/help/en/model-studio/regions).

## QwenCloud Token Plan

Harness includes `@zhivex-ai/qwen` 0.15.2. For an interactive Token Plan session,
set `QWEN_BASE_URL=https://token-plan.maas.qwencloudapi.com/compatible-mode/v1`
and supply your dedicated Token Plan key through `DASHSCOPE_API_KEY` (or
`QWEN_API_KEY`). Start `zhx chat --provider qwen --model qwen3.8-max`, or select
`qwen3.8-flash`. Enter/export credentials privately; never paste them into chat
or commit them. Leave `QWEN_WORKSPACE_ID` unset for this endpoint.

The endpoint is explicit: Harness does not infer billing mode from a key prefix.
The interactive setup also supports this fixed Token Plan endpoint with managed keys. Arbitrary custom endpoints require environment credentials.
Use standard pay-as-you-go credentials for backend/scheduled workloads. See the
[official Token Plan quickstart](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart)
for matching key types and endpoints. Account entitlements are provider-controlled;
local transport tests do not certify access to a paid plan.
