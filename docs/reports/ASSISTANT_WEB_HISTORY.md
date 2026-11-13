# Assistant standalone web history

The standalone browser launcher and entrypoints are retired. The following
snapshots preserve the former interface, onboarding and first-session procedure;
they are not current startup instructions. Shared UI settings still have historical
context here. Start with the [native guide](../assistant/ASSISTANT_DESKTOP.md) and
[retirement policy](../architecture/WEB_RETIREMENT.md).

- [Interface](#interface)
- [Onboarding and settings](#onboarding)
- [First-session walkthrough](#first-session)

<a id="first-session"></a>

## Assistant: first usage session

Goal: try a useful flow today and record reproducible problems.
This starts the pilot; it does not replace the three acceptance days in
[ASSISTANT_PILOT.md](../assistant/ASSISTANT_PILOT.md).

For the terminal-free flow, use [web onboarding](ASSISTANT_WEB_HISTORY.md#onboarding).
The following commands apply to the technical pilot and advanced CLI host.

<a id="first-session-preparation"></a>

### Preparation

From the repository root:

```sh
bun run prepare:assistant
bun run --cwd packages/assistant build
bun run --cwd packages/assistant typecheck
```

Set the credentials described in pilot onboarding in the terminal.
Do not paste secrets into conversations or reports. OpenAI requires
`OPENAI_API_KEY`; Qwen requires `DASHSCOPE_API_KEY` or `QWEN_API_KEY` and
`--provider qwen`. Always use the same provider/model and directory when restarting.
If an instance already exists, preserve its options and encryption key.

The following commands use OpenAI and a new directory as examples.
Replace `123456789` with the owner's numeric Telegram account ID:

```sh
bun run --cwd packages/assistant start --doctor --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789 --web
```

Continue when it returns `ok: true`. This is an offline diagnostic: it checks
local configuration but does not authenticate with Google, Telegram or the model.
With the host stopped, connect Calendar if it is not already connected:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-connect
```

Open the local OAuth URL and complete consent with the test account.
Then start the host and leave the terminal open:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789 --web
```

Open the `assistant-web` link. Link Telegram by sending the bot a private
`/start CODE` message using the code printed in that terminal. The web link and linking code
are private. The Vite interface with `?demo=1` uses simulated data: for this test,
use only the host link.

<a id="first-session-3045-minute-walkthrough"></a>

### 30–45 minute walkthrough

Use test events and attendees under your control. Approved modifications
can notify event attendees.

| Step | Action | What to check |
| --- | --- | --- |
| 1 | Open the web schedule and ask via Telegram, “Show me today's schedule and its conflicts.” | Account, date, zone and events match Calendar. |
| 2 | Ask to move a test event to a specific time. | The proposal shows event, time and attendees; Calendar stays unchanged before approval. |
| 3 | Reject that proposal. | The event does not change. |
| 4 | Request another proposal and approve it once from its review. | Calendar reflects the exact change; record any unexpected notification. |
| 5 | Leave a proposal pending, stop with Ctrl+C and wait for `assistant-stopped`. Restart with the same command. | The review remains available. If expired, cancel and propose again. Open the new web link. |
| 6 | Schedule the summary a few minutes ahead from the web or `/daily HH:mm America/Argentina/Buenos_Aires`. | `/daily status` shows the next time; a summary arrives and matches the schedule. Keep the host running. |
| 7 | Send `/daily pause`. | Paused status; no new runs remain enabled. |

Web and Telegram let you check each surface; do not assume they create the same
conversation. The summary requires Calendar and linked Telegram. Its content is
deterministic: it does not yet execute general instructions such as researching news.

Do not use `--recover` for a normal restart. Reserve it for an actual crash and
follow the pilot recovery guide. If a response is lost, inspect
state before repeating the action.

<a id="first-session-record-results"></a>

### Record results

Save a private copy of this table and complete one row per attempt:

| Time and zone | Scenario | Expected | Observed | Approximate duration | Manual interventions | Available run/operation ID | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | Pending |

Suggested outcomes: completed, blocked, incorrect or uncertain. Also record
confusing steps, unnecessary approvals and automation opportunities.
Keep the code revision (`git rev-parse HEAD`) and note local changes
if applicable. Do not attach databases, credentials, private links or
personal content to the shared report.

If an unapproved write, wrong account, duplication or unexplained uncertain effect
occurs, stop the process and preserve state for diagnosis.
At the end of the session, leave the summary paused or delete it with `/daily delete`.
If continuing the pilot another day, keep credentials and directory; final
revocation is described in the pilot guide.

<a id="interface"></a>

## Assistant web

The local interface implements the approved visual proposal: home with schedule,
approvals, daily summary, conversations, connections and modules. There is one
instance per owner. It does not yet include an agent catalog or multiple bots.

<a id="interface-setup-without-a-terminal"></a>

### Setup without a terminal

Double-click the local macOS launcher. The new managed mode lets you test the
model and connect Calendar/Telegram from the web before creating the host.
See [web onboarding](ASSISTANT_WEB_HISTORY.md#onboarding) for usage,
launcher preparation and distribution limitations.

<a id="interface-run-the-advanced-cli-host"></a>

### Run the advanced CLI host

Prepare the local candidate as described in `packages/assistant/README.md`, then:

```sh
bun run --cwd packages/assistant build
bun run --cwd packages/assistant start --directory "$HOME/.zhx-a" --owner local-owner --config /path/assistant.json --web
```

Open the private link in the `assistant-web` log. The port is dynamic;
`--web-port 4176` sets a fixed port. The server listens exclusively on
`127.0.0.1`. The random token travels in the initial fragment, is saved in
sessionStorage and removed from the URL. It changes on restart: reopen the new
link. Do not publish through a proxy or share the link.

Conversations and approvals retain host persistence. The web uses the public
Harness protocol and fetches the review again when approving;
a changed or expired revision requires a refresh. A repeated decision does not
repeat the effect. Calendar retains its existing revalidation and idempotency.
The view shows the latest 20 conversations and up to 10 runs per conversation.

The daily summary requires Calendar and linked Telegram. Editing, pausing and
deleting it use the existing persistent scheduler. The schedule uses the system
time zone; an application embedding the host can pass `web.timeZone`.
The summary time zone is configured separately in its form.

In the advanced CLI host, connections, provider and modules show their actual
state and are configured through host flows. In managed mode, the Settings button
opens the web forms for credentials and connections. Opening the schedule does not modify events.

<a id="interface-visual-demo"></a>

### Visual demo

```sh
bun run --cwd packages/assistant dev:web --host 127.0.0.1 --port 4175
```

Open `http://127.0.0.1:4175/?demo=1`. The label indicates sample data.
Changes are simulated in memory and reset on reload: no calls are made to the
host, Telegram or Calendar. The Vite server serves this design view;
for real data, use the host with `--web`, which serves the build and API together.

<a id="interface-validation"></a>

### Validation

`bun run --cwd packages/assistant smoke:installed` builds the interface and validates
the isolated consumer. `tests/web.test.ts` covers authentication, Host/Origin,
asset confinement, send deduplication, recovery and token rotation,
stale revisions, single effects and incomplete schedules. Existing regressions
cover real restarts, Telegram, Calendar and the scheduler.

Visual evidence and intentional differences: `packages/assistant/web/design-qa.md`.

<a id="onboarding"></a>

## Assistant: web setup

The local macOS launcher lets you open Assistant with a double click and configure
the model, Calendar and Telegram from the browser. No commands are needed during
the first session or to reopen it. The service listens only on loopback.

<a id="onboarding-use-this-local-copy"></a>

### Use this local copy

Open `release-artifacts/Zhivex Assistant.app`. The launcher opens the browser with
private access and reuses an already running instance. On first use:

1. Click **Set up my assistant**.
2. Choose OpenAI, Muse / Meta, Qwen or a compatible provider, enter model and key, and click
   **Test and save connection**. The test performs a real short generation,
   which can consume quota. It does not certify provider streaming or tools.
   For current information, check **OpenAI web search**: this selects
   Responses automatically and sends the tool in the compatibility test.
   Searches incur additional OpenAI charges; the short test does not force
   the model to search. A compatible model and the official endpoint are required.
   Muse / Meta and Qwen use native Harness adapters. For a QwenCloud account, choose **Qwen service → QwenCloud**
   (or **QwenCloud Token Plan** if the key belongs to that plan); neither region
   nor workspace is required. Saved profiles without a service retain Model Studio.
   In **Alibaba Cloud Model Studio**, Qwen lets you
   choose region and workspace; outside Singapore, the regional workspace ID
   is required. Without a workspace, the default international endpoint is used.
   Assistant web search remains available only for OpenAI.
3. Optionally connect Google Calendar. If the distribution has its OAuth client
   configured, consent is enough. This local copy lets you import a **Desktop** OAuth
   client JSON file or enter its details from the web.
   Creating and enabling that application in Google remains the
   distributor/operator's task: no official Zhivex client is simulated.
4. Optionally create a bot in BotFather and enter its token. Open the Telegram
   link, press Start, return and click **I already sent the message**. Confirm
   the detected account from the web. You do not need to find its numeric ID.
5. Click **Start chatting**. Telegram is linked to the account
   confirmed from the web. No test messages are sent automatically.
6. With Calendar and Telegram linked, configure the daily summary under
   **Automations**. Delivery requires Assistant to remain running.

Configuration is stored in the system keychain (Keychain on macOS,
Secret Service on Linux), without a plaintext-secret fallback. Keys
are not returned in configuration responses. The Calendar encryption key
is generated and retained automatically in that keychain.

**Settings → Shut down Assistant** stops the service. Reopening the app
restores saved configuration and opens a new access link. Closing the
tab does not stop the service. A keychain failure can be retried from the
web. After an abrupt shutdown, only processes verified as dead can be recovered.

<a id="onboarding-configurations-and-history"></a>

### Configurations and history

Managed mode uses `~/.zhx-app`, separate from existing CLI instance
directories. It does not import or modify those instances automatically.

Changing provider or capabilities creates a configuration with separate
conversations; previous configurations remain saved and selectable from the
web. Approvals are neither migrated nor reused with another profile. Before switching,
resolve/cancel pending tasks and pause the daily summary.
Calendar connections must be authorized in the new configuration.

If an OpenAI key is already saved, **Settings → Configure web search**
reuses it without asking for or showing it. Then click **Start chatting now**.
The new configuration preserves the model and enables Responses and web search;
Calendar and Telegram are linked again if needed. The previous one remains
available under **Saved configurations**. Citations are preserved in history
and shown as links in the web interface. Code execution,
file search and other OpenAI tools are not enabled automatically.

<a id="onboarding-prepare-the-launcher-developmentdistribution"></a>

### Prepare the launcher (development/distribution)

After preparing the local Harness candidate as described in the README:

```sh
bun run --cwd packages/assistant build:launcher
```

This generates `release-artifacts/Zhivex Assistant.app`, ignored by Git. This launcher
points to Node and this checkout: **it is not a standalone, signed or notarized
installer**. Do not move/delete the project or Node while using it. Distributing
Assistant to other machines requires packaging runtime and dependencies, signing,
updates and product OAuth configuration.

Managed mode is also available to developers through
`node packages/assistant/dist/cli.js --setup --open`; without arguments, the CLI
selects this mode. Previous explicit CLI commands remain available.
Do not combine `--setup` with previous host flags; it accepts `--directory` and
`--web-port` for a separate supervisor.

`bun run scripts/preview-onboarding.ts` (from the package) serves a test view
with temporary storage and a simulated model; do not use it as a personal
instance. Its data is removed when stopped with SIGTERM.

<a id="onboarding-validation"></a>

### Validation

`tests/web-setup.test.ts` covers setup without credentials, rejection of access
without a token and cross-origin requests, separate storage, duplicate-instance
locking, access rotation, history across restarts and configurations,
keychain failures, provider testing, OAuth callback and
local Telegram owner confirmation. Integrations are simulated;
these tests do not replace real-account testing.

<a id="onboarding-multiple-agents-and-providers"></a>

### Multiple agents and providers

In Assistant web, **Add agent** creates an independent agent. Give it a
name, save it and connect its provider and model: OpenAI, Muse / Meta, Qwen or an
OpenAI-compatible API. Each agent saves its own credentials,
conversations and Calendar and Telegram connections. Previously saved
configurations appear as agents without migrating or deleting history.

The **Agent** selector lets you return to any saved agent;
**Settings → Your agents** shows provider and model and lets you
rename agents. Up to 50 agents are supported, with one active at a time. Before
switching, complete or cancel pending tasks and approvals and pause the daily
summary. Restart recovers the last active agent. If the new agent cannot
start, Assistant attempts to recover the previous one and preserves the draft.

<a id="onboarding-reuse-keys-and-update-models"></a>

#### Reuse keys and update models

When adding an agent, **Use a saved connection** lets you select an
already connected provider and choose the model without reentering the API key.
The key stays in the keychain: the interface receives only the connection ID
and description. The storage format migrates automatically
to store one key per connection; each agent keeps
its model configuration and a reference to that key.

To update an agent, select it and open **Settings → Your agents**.
Edit its model and click **Test and change model**. Access is tested with the
saved key before applying the change. The agent, its connections
and conversations are preserved; subsequent messages use the new model. First,
complete pending tasks and pause automations. If the
new model cannot start, restoration of the previous model is attempted.

<a id="onboarding-manage-saved-connections"></a>

#### Manage saved connections

**Settings → Saved connections** shows connections and the
agents using them. Enter the new API key and choose **Test and update
key** to update it for all those agents and any draft using
the same connection. Rotating the key does not change the connection ID.

Before saving, Assistant tests every associated model and protocol. If the
active agent uses that connection, it must have no pending tasks and its daily
summary must be paused; it restarts with the new key while preserving history. If
testing, startup or keychain saving fails, the previous configuration is
preserved and recovery of the active agent is attempted. Keys are never returned
to the interface and the field clears after a successful update.

<a id="onboarding-delete-agents-and-connections"></a>

#### Delete agents and connections

Under **Settings → Your agents**, **Delete agent** asks for confirmation and deletes
the agent together with its conversations and local data. Its provider connection
is preserved. If it is the active agent, it stops; deletion is disallowed with
pending tasks or approvals or an active daily summary. You can then
select another agent or create a new one.

Under **Saved connections**, **Delete connection** removes its key from the keychain
after confirmation. This is allowed only when no agent or draft uses it.
The interface shows usage and disables the button, and the server checks
the condition again before deleting. Connections without agents persist
across restarts until you choose to delete them and remain available for reuse.

<a id="onboarding-change-an-agents-connection"></a>

#### Change an agent's connection

Select the agent and open **Settings → Your agents → Connection for …**.
Choose a saved connection and click **Test and change connection**. You can specify
a different model; leaving the field blank uses that connection's model.
There is no need to enter the API key again.

The agent preserves identity, history, Calendar and Telegram. Subsequent
replies use the new provider with conversation context. Switching
requires completing pending tasks and pausing the daily summary. The connection
is validated before applying it, and restoration of the previous one is attempted if startup
or saving fails. The previous connection remains saved and can be deleted if no
agent or draft uses it.

Under **Your agents**, each agent has its own tab. Switching tabs only
changes visible configuration and preserves fields being edited.
**Activate agent** changes the responding agent without leaving Settings.
Tabs support left/right arrows and Home/End keys;
on small screens they scroll horizontally.

Agent creation also uses tabs: **Agent**, **Model**,
**Calendar** and **Telegram**. Only one form is shown at a time and data
is preserved when switching tabs. **Save and continue** saves the name and
opens Model; Calendar and Telegram remain optional.

<a id="onboarding-settings-panel"></a>

### Settings panel

Settings uses side navigation with **Agents**, **Connections** and
**Integrations**, a compact list and an editor for the selected item.
In Agents, **Save changes** validates and saves name, connection, model and web
search in one operation. **Cancel** restores saved values. To edit
an inactive agent, use **Activate agent**. Switching sections with pending fields
asks for confirmation before discarding them.

API keys are edited in Connections. Option menus retain deletion
actions and protection for connections in use. Integrations
shows each agent's Calendar and Telegram; they are connected during creation.
On mobile, navigation goes from list to detail and save buttons remain
visible while scrolling editor content.
