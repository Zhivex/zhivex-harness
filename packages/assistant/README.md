# Zhivex Assistant — phase 5

Private, unpublished local product. Consumes only named public Harness exports.
See the [MVP plan](../../docs/plans/ASSISTANT_MVP_PLAN.md),
[contracts](../../docs/assistant/ASSISTANT_CONTRACTS.md) and
[phase 1 guide](../../docs/assistant/ASSISTANT_HOST.md).

Implemented: general assistant profile, foreground persistent host, private Unix
transport, SQLite conversations/runs/approvals, durable activity replay, explicit
dead-owner recovery, client serialization and sanitized startup/shutdown logs.
The default profile exposes no tools. A trusted embedding application can supply
an explicit profile/catalog and MCP configuration; ordinary messages cannot.

Telegram private-chat integration, explicit owner pairing, persistent input/output
queues and chat approvals are implemented. See the [Telegram guide](../../docs/assistant/ASSISTANT_TELEGRAM.md).
Google Calendar OAuth, durable proposals and Telegram-approved conditional event
updates are implemented. See the [Calendar guide](../../docs/assistant/ASSISTANT_CALENDAR.md)
for setup, profile-directory compatibility and recovery limits. A persistent daily agenda scheduler and explicit personal preferences are implemented;
see [automations](../../docs/assistant/ASSISTANT_AUTOMATIONS.md). Activate from the paired chat
with `/daily 08:00 America/Argentina/Buenos_Aires`; use `/daily status` and `/memory list`.
This is a single-owner local host, not a remote gateway or an OS-managed daemon.

## Development

Use Bun for packages, builds and tests; Node 22.13+ for the built host.
Phase 1 requires the **local Harness candidate**: the registry 1.6.3 pin does not
contain the new experimental `createProfiledHarness` export yet. No version has
been published or silently claimed compatible with that older artifact.

From the repository root:

```sh
bun run prepare:assistant
bun run check:assistant
bun run smoke:assistant:web
```

`prepare:assistant` builds Harness, installs locked Assistant dependencies and installs
the local candidate. `check:assistant` runs types, tests, the offline example and
the isolated installed-consumer smoke. The browser checks require Chromium
(`cd packages/assistant && bun x playwright install chromium`). CI runs these checks
on every pull request; the installed consumer also runs with Node 22.13 and 24.

`prepare:local` packs the existing build and installs the artifact with Bun
`--no-save --ignore-scripts`; it does not rewrite package.json or bun.lock.
A normal `bun install` restores the registry dependency and requires running
`prepare:local` again. Rebuild Harness first after engine changes.

For isolated installed-package acceptance:

```sh
bun run --cwd packages/assistant smoke:installed
```

This installs a temporary candidate consumer, checks resolution, types and tests,
and runs the offline example with Node. Host tests launch separate Node processes,
kill/recover the service, resume an exact approval and check conversation context.
Dependency installation may require network access; no model API is called.

## Open and configure in Tauri

Build with `bun run --cwd packages/assistant build:desktop`, then open
`packages/assistant/src-tauri/target/release/bundle/macos/Zhivex Assistant.app`.
Setup, connections and conversations run in the native window. See the
[native guide](../../docs/assistant/ASSISTANT_DESKTOP.md) and
[web retirement policy](../../docs/architecture/WEB_RETIREMENT.md).

## Run (advanced CLI host)

Choose a short private path because Unix sockets have a path-length limit:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-a" --owner local-owner --provider openai
```

Configure the provider credential in the environment. The ready JSON contains a
private credential-file path, never its token. Keep this process running. SIGINT
or SIGTERM stops admission and drains accepted work; pending approvals survive.
Restart with the same directory, owner, provider/model and profile configuration.
After a crash, add `--recover`; recovery refuses a live owner and never replays
an uncertain effect. See the guide for client calls and recovery limits.

## Structure

- `src/contracts.ts`: draft versioned records for later product integrations.
- `src/host.ts`: private directories, immutable host binding, engine/service lifecycle.
- `src/client.ts`: negotiated local commands, serialized mutations and activity replay.
- `src/cli.ts`: foreground service and signal handling.
- `src/runtime.ts`: minimal one-task embedding example, not the conversation API.
- `src/telegram/`: Bot API adapter, separate SQLite queues and owner/approval bridge.
- `src/calendar/`: OAuth, encrypted credentials, event proposals and operation reconciliation.
- `src/automation/`: timezone scheduling, explicit preferences and read-only daily summaries.
- `tests/`: record validation and real-process recovery acceptance.
- `scripts/`: local candidate setup and isolated installed-package acceptance.

Assistant's `state/host.json` stores its owner/profile binding. Harness owns its
session and run database under `workspace/.zhivex-harness`. Assistant never reads
or writes its internal tables. Schema validation alone is not authorization.

Enable Telegram with `--telegram-owner NUMERIC_ID` and `ASSISTANT_TELEGRAM_BOT_TOKEN`.
Follow the locally printed pairing challenge. Existing webhooks are never removed
automatically. The token stays in memory, and uncertain sends are not auto-retried.

## Pilot onboarding

To try Calendar, Telegram and Assistant today, follow the
[first-session walkthrough](../../docs/reports/ASSISTANT_WEB_HISTORY.md#first-session).

Follow the [complete pilot guide](../../docs/assistant/ASSISTANT_PILOT.md) for offline preflight
(`--doctor`), Google consent, Telegram pairing, recovery and the three-day acceptance
record. Local validation does not certify a live account or a completed pilot.

## Configurable providers and modules

Daily tasks, one-shot reminders, explicit notes, Gmail drafts/reads, Drive text
search/reads, read-only GitHub MCP and provider-independent Brave search are
available as opt-in modules. See [daily tools](../../docs/assistant/ASSISTANT_DAILY_TOOLS.md)
for setup, credential references, approval behavior and delivery limits.
The new-agent wizard has a **Herramientas** tab. Existing agents retain their
original module binding; create a new agent to change its tool catalog.

Use `--config /path/assistant.json` for an explicit OpenAI-compatible provider and
composed Calendar/MCP modules. See [configuration, extension contract and compatibility](../../docs/assistant/ASSISTANT_EXTENSIONS.md).
The instance remains single-owner. Existing Calendar-only profiles remain compatible;
changing provider or composing additional modules requires a fresh runtime directory.

## Embedded interface development

Tauri uses the React interface and authenticated loopback server in this package.
Browser checks remain useful for this shared UI. `dev:web` with `?demo=1` is a
visual development fixture; independent browser product entrypoints are retired.

### Muse / Meta and Qwen

Tauri onboarding offers Muse / Meta and Qwen through their native Harness
adapters. Protocol configuration is unnecessary. Integrated web search remains
exclusive to OpenAI. Previous profiles remain compatible.

For CLI v1 configuration, the `provider` field also accepts:

```json
{ "kind": "meta", "model": "muse-spark-1.3", "apiKeyEnv": "MODEL_API_KEY" }
```

```json
{ "kind": "qwen", "model": "qwen3.6-plus", "apiKeyEnv": "DASHSCOPE_API_KEY", "region": "singapore" }
```

Use a model enabled for your account. Qwen supports `workspaceId` and regions
`singapore`, `beijing`, `hong-kong`, `tokyo`, `frankfurt` and `virginia`. Outside
Singapore, an explicit workspace is required; without a workspace, the SDK's
international endpoint is preserved. Keys are read from the named variable and
are not included in the JSON file. In the TypeScript API, pass this configuration
as `assistantProvider` to `startAssistantHost`; `compatibleProvider` still
accepts previous OpenAI-compatible configurations.

For QwenCloud, add `"service": "qwencloud"` to the Qwen configuration
(for example with `"model": "qwen3.8-flash"`). For a Token Plan key,
use `"service": "token-plan"`. These routes require neither region nor workspace.
Omitting `service` preserves Model Studio and existing profiles.

## Task metrics and evaluation preparation

Conversation runs now produce private, durable task observations for duration,
explicit corrections, operator-verified outcomes and estimated token cost.
Completed runs remain unverified until reviewed. Missing usage or pricing remains
unknown. Read the [task metrics guide](../../docs/assistant/ASSISTANT_TASK_METRICS.md) for
pricing, authenticated report/feedback APIs, grouping semantics and scope limits.

Validate the initial 30-case suite with `bun run eval:tasks --validate` or prepare
90 unexecuted trials with `bun run eval:tasks --plan /tmp/assistant-evaluation.json`.
These commands do not call a model or modify external services.

## Microsoft 365 / Outlook

The new-agent **Herramientas** tab supports Microsoft work accounts: read/search
mail, create approved drafts, and read/create personal calendar appointments.
Microsoft calendar supplies the web agenda and daily summary. Integrations shows
the account and supports reauthorization. See [Entra ID setup and scope limits](../../docs/assistant/ASSISTANT_MICROSOFT.md).

## Proactive alerts

Opt-in detection of calendar conflicts, due tasks and explicitly tracked Gmail or
Outlook replies is available with the daily module. Configure quiet hours, timezone,
channel and notification budget in **Tareas y recordatorios → Configurar avisos**.
For conversational configuration and reply tracking, select proactive tools when
creating an agent or use `{ "kind": "daily", "proactive": true }` in a fresh CLI
profile. Existing daily profiles retain their tool catalog. See the
[proactive guide](../../docs/assistant/ASSISTANT_PROACTIVE.md) for behavior and limits.
