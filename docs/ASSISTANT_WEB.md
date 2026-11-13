# Assistant web

> Historical standalone-web instructions below are superseded by the
> [Tauri interface and web retirement policy](WEB_RETIREMENT.md). CLI and
> shared embedded UI capabilities remain available as described there.

The local interface implements the approved visual proposal: home with schedule,
approvals, daily summary, conversations, connections and modules. There is one
instance per owner. It does not yet include an agent catalog or multiple bots.

## Setup without a terminal

Double-click the local macOS launcher. The new managed mode lets you test the
model and connect Calendar/Telegram from the web before creating the host.
See [web onboarding](ASSISTANT_WEB_ONBOARDING.md) for usage,
launcher preparation and distribution limitations.

## Run the advanced CLI host

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

## Visual demo

```sh
bun run --cwd packages/assistant dev:web --host 127.0.0.1 --port 4175
```

Open `http://127.0.0.1:4175/?demo=1`. The label indicates sample data.
Changes are simulated in memory and reset on reload: no calls are made to the
host, Telegram or Calendar. The Vite server serves this design view;
for real data, use the host with `--web`, which serves the build and API together.

## Validation

`bun run --cwd packages/assistant smoke:installed` builds the interface and validates
the isolated consumer. `tests/web.test.ts` covers authentication, Host/Origin,
asset confinement, send deduplication, recovery and token rotation,
stale revisions, single effects and incomplete schedules. Existing regressions
cover real restarts, Telegram, Calendar and the scheduler.

Visual evidence and intentional differences: `packages/assistant/web/design-qa.md`.
