# Assistant phase 2 — Telegram

Implemented in the local candidate, not published. One bot, one explicitly chosen
owner, one private conversation. Telegram, its state and delivery policy live in
Assistant; this phase changes no Harness protocol or approval guarantees.

## Start and link

Build/install the local Harness candidate as described in
[Assistant setup](../packages/assistant/README.md). Supply the bot token through
`ASSISTANT_TELEGRAM_BOT_TOKEN`; do not put it in a command argument, source file or
chat. Obtain the owner's numeric Telegram user ID through a trusted source.
Usernames are not identities.

```sh
bun run --cwd packages/assistant build
bun run --cwd packages/assistant start --directory "$HOME/.zhx-a" \
  --owner local-owner --provider openai --telegram-owner 123456789
```

The foreground host prints a random pairing challenge locally. Send the exact
`/start CODE` text to the bot from the selected account in a private chat within
10 minutes. Other users, groups, bots and incorrect/expired challenges are ignored.
The code is single-use. Restarting while unlinked creates a new challenge; a linked
owner remains linked. Challenge-bearing pairing messages are redacted in storage.

`getMe` verifies the bot identity; the state binds that identity, the local owner
and Telegram user ID. Reusing the directory with another bot/account fails closed.
An existing Telegram webhook prevents startup: the host does not silently remove
or replace it. Use a dedicated bot configured for polling.

The default assistant profile is still tool-free. A trusted embedding application
can supply its explicit profile/catalog and MCP connections through
`startAssistantHost({ ..., engine, telegram: { token, expectedUserId } })`.
Telegram messages cannot change those settings. Calendar tools and their trusted proposal review are described in [phase 3](ASSISTANT_CALENDAR.md).

## Conversation and decisions

- Ordinary text starts a turn in the persistent Telegram session. The session is
  reconstructed through public Harness APIs; no internal tables are accessed.
- `/pending` shows the most recent run and, if applicable, a fresh view of its
  pending approval. It never renews an approval's expiry.
- `/cancel` uses a separate control worker and can cancel a currently active turn.
- `/help` lists the commands. Attachments are acknowledged as unsupported; no
  files, audio, images or links are downloaded by the channel.
- While an approval is pending, another ordinary message cannot start a new run.

An approval displays the actual engine action/arguments and any available file
preview as plain text, split into bounded messages. Large or incomplete reviews
require local review; they never get a positive approval button. The final decision
message is sent only after every review part was confirmed sent.

Buttons carry random opaque tokens, not model-authored commands or arguments.
Each token binds to the stored session, run, revision, approval IDs/digests,
rendered review, expiry and exact decision message ID. The callback must come from
the linked account in its linked private chat. The bridge re-reads the engine
review and rejects changed content before dispatch. A valid decision consumes
its token durably before execution; replay cannot reauthorize the action.

The ordinary `approval.resolve` contract is used. Policies that require a trusted
local interactive review still return `EXPLICIT_REVIEW_REQUIRED`; this channel
never calls `dispatchReviewed` or falsely attributes a Telegram click to Desktop.
Expired approvals require cancellation and a new proposal. Natural-language
messages such as “approve” cannot approve a pending action.

## Persistent queues and recovery

Assistant owns `state/telegram.sqlite` (SQLite with full synchronous commits),
separate from Harness persistence:

| Table | Purpose |
| --- | --- |
| meta | Bot/owner binding, polling cursor, pairing hash/expiry, session association |
| inbox | Deduplicated normalized Telegram updates, durable engine-command intent |
| outbox | Ordered messages, attempt count, retry time, remote message ID and status |
| reviews | One-use decision tokens and exact review snapshots |

The polling cursor advances in the same transaction that stores incoming updates.
Repeated update IDs, including after restart, do not create new tasks. Ignored
updates advance the cursor without storing unauthorized message content.
Session creation uses a stored unique title to recover a lost creation reply.
Before a run/decision is dispatched, its intent and the prior session run IDs are
committed. After interruption the bridge queries Harness to reconcile the result.
An unresolvable admission stays reported as uncertain; it is not blindly replayed.
Use a dedicated Telegram session; do not inject independent local-client runs into
it while a channel command needs reconciliation.

Delivery transitions:

- `pending → sending → sent` on a valid Telegram acknowledgement.
- Explicit rate limits use persisted `retry_after`, up to five attempts.
- Definitive API rejection becomes `failed`.
- Timeout, transport loss, ambiguous server error or restart during `sending`
  becomes `uncertain`; no automatic resend.

This provides durable queues and prevents blind duplicates; it does **not** claim
exactly-once remote delivery. `/pending` can explicitly request a new current view
if a review was lost. Failed/uncertain rows remain available to local diagnostics;
there is no automatic resubmission or retention/deletion command in this phase.
Inbox admission stops at 100,000 records rather than silently evicting dedup keys.

On clean shutdown, polling stops and admitted worker activity drains before the
engine closes. After process death restart with the same flags plus `--recover`.
Recovery refuses live owners. The Telegram store uses its own private owner lock;
a short exclusive recovery guard prevents concurrent lock reclamation. If the
process dies during that tiny recovery window, `telegram.recovery` remains and
startup fails closed; inspect it locally with all hosts stopped before removal.
Do not remove a live host's locks or edit queue records to force execution.

`host.diagnostics().telegram` exposes linked state, offset, counts by queue status
and a sanitized last-fault code. Tokens and messages are not included. Provider
and Telegram errors do not log request URLs containing the bot token. A rejected
or unreachable polling endpoint is retried with bounded pacing; diagnose it locally.

## Protocol sources and limits

Based on the official [Telegram Bot API](https://core.telegram.org/bots/api):
[getUpdates](https://core.telegram.org/bots/api#getupdates),
[sendMessage](https://core.telegram.org/bots/api#sendmessage),
[inline buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton) and
[callback queries](https://core.telegram.org/bots/api#callbackquery).
The implementation uses HTTPS with redirects disabled, bounded responses, request
timeouts and callback acknowledgement. Polling is exclusive with webhooks.
Telegram retains unreceived updates for at most 24 hours, so this is not an
unlimited offline inbox.

## Verification

Offline acceptance uses a simulated Bot API and real Harness/local persistence.
It covers unauthorized users/groups, linking, duplicate inputs, approval/rejection,
wrong message IDs, expired/stale decisions, restart, rate limits, failed review
parts, active cancellation and lost command acknowledgements. A separate Node
process is killed after a simulated remote send but before acknowledgement; on
recovery the delivery is uncertain and is not sent twice.

No real bot token was used, no Telegram message was sent and no live provider was
called during implementation. A live bot smoke remains deployment validation,
not a claim made by these deterministic tests.

### Local evidence — 2026-11-10

- Installed consumer: typecheck/build, 15 tests with 71 assertions and the offline
  Node example passed. Includes real-process SIGKILL/recovery and active cancellation.
- Architecture, stable API contracts, tooling typecheck, documentation and diff
  whitespace checks passed. CLI build/help includes the Telegram startup option.
- Tested Harness candidate: 1.6.3, SHA-256
  `d167e7d1a4d6dcffde2e85c3a2aacf2fdecd50cbc3927bb4d0cabb7b2b879e87`.
  This identifies the engine tarball used by the consumer, not a published release
  or a hash of Assistant's new source files.
- Bun 1.4.3 and Node 22.21.0. Node's SQLite experimental warning is expected on
  that runtime; the store is exercised in the separate Node crash test.
- Continued on `feat/assistant-phase-0`; no commit, publication or merge.

Daily summaries and explicit preference commands are documented in [phase 4](ASSISTANT_AUTOMATIONS.md). They use the same owner authentication and durable outbox.
