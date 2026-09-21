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
or kernel keyring. Choose temporary use or supply an environment key instead.
`ZHIVEX_HARNESS_CREDENTIAL_STORE=disabled` disables native keychain access, useful
for isolated tests and installations where keychain use is prohibited.

The CLI uses its own `ai.zhivex.harness.cli` service with separate provider accounts.
It does not read, replace or delete Desktop's keys. Windows native support is still
outside the CLI support contract; adding this binding does not certify Windows.

## Environment and automation

Environment keys take precedence over saved and temporary keys, including provider
aliases. The CLI reports that precedence when managing a key while an environment
key exists. Changing the saved key does not override the launching shell.

One-shot commands (`run`, `review`, `resume`), JSON/JSONL, `doctor`, `providers`, and
service connections retain their existing environment/host-owned behavior: they
never prompt for keys or access the system keychain. `doctor` checks environment
key presence only; it does not validate saved keys or contact providers. Use the
interactive console to resume a conversation with a managed key.

## Boundaries

Keys are kept outside profiles, repositories, run metadata and chat history. Managed
keys are passed only to provider model clients, not to `process.env`, MCP or command
execution environments. Do not paste a key into a normal conversation.

Managed keys require default provider endpoints. Shell-defined base URL or Qwen
region/workspace overrides are rejected before reading the keychain. To intentionally
use a custom endpoint, supply its credential explicitly through the environment.
Credential storage is separate from live provider validation; the first model
request checks account access and may be billable.
