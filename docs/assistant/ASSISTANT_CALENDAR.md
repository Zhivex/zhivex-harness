# Assistant — Calendar (phase 3)

Local integration for one owner and one fixed calendar. Assistant owns
OAuth, credentials and the operation journal; Harness retains policy,
durable approvals and execution. No Google endpoints are added to the engine.

## Connect and run

Prepare the local candidate and build Assistant following its [README](../../packages/assistant/README.md).
In Google Cloud, enable Calendar API, configure consent (and a test user
if applicable) and create an OAuth client of type **Desktop app**. This uses
[OAuth for installed applications](https://developers.google.com/identity/protocols/oauth2/native-app)
with PKCE S256, single-use state and a callback on `127.0.0.1` with an ephemeral port.
The browser must be able to reach the loopback interface of the machine running Assistant.

Set these environment variables:

- `ASSISTANT_GOOGLE_CLIENT_ID`: Desktop client.
- `ASSISTANT_GOOGLE_CLIENT_SECRET`: if included in the client configuration.
- `ASSISTANT_CREDENTIAL_KEY`: a random 32-byte key encoded as base64.
  Generate it once (for example `openssl rand -base64 32`), store it outside
  the state directory and reuse it after restarts. It is not generated or replaced
  automatically; a different key cannot decrypt the existing connection.
- Model provider credentials and `ASSISTANT_TELEGRAM_BOT_TOKEN`, as in
  the [Telegram instructions](ASSISTANT_TELEGRAM.md).

With the host stopped:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-cal" --owner local-owner --calendar-connect
```

Open the printed URL in your browser and complete consent. Requested scopes are
`openid`, `email` and `calendar.events`. Do not send codes, tokens or the key to
Telegram. The flow expires in ten minutes; it does not offer a public remote callback.
Then start the host with the same directory, owner and credentials:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-cal" --owner local-owner --provider openai --calendar --calendar-id primary --telegram-owner 123456789
```

Replace the ID with the owner's ID and complete local Telegram linking.
`--calendar-id` is fixed in the host profile; its default is `primary`.
To inspect or disconnect, stop the host and run the same base command
with `--calendar-status` or `--calendar-disconnect`. Disconnection first removes
local access and reports whether Google confirmed revocation. If `revoked` is false,
also revoke access from the Google account. A rejected refresh requires new consent.

**Directory compatibility:** profiles from earlier phases remain immutable.
Enabling Calendar requires a new private directory and new Telegram linking;
conversations and approvals are not migrated to the expanded profile. Changing
calendars or reconnecting after disconnection also requires a new host.
Reauthorizing the same account without disconnecting preserves connection identity.
Never delete `host.json` to bypass this check.

## Modification flow

1. `calendar_read_list/read` queries the calendar. Listing: up to 100 events
   per page, a maximum 90-day interval, explicit pagination and completeness.
2. `calendar_read_propose` retrieves the event and persists a 15-minute proposal.
   It returns only `operationId` and the immutable proposal's SHA-256 digest to the model.
3. `calendar_write_apply` requests normal Harness approval. The host loads
   the proposal from its journal and shows the event, calendar,
   account, before/after, attendees, expiry and notification effects in Telegram.
   Displayed content is bound to the Telegram review and digest.
   The reference prevents engine PII redaction from altering arguments
   during recovery. A model-written summary is not trusted.
4. Approval validates owner/chat/message/revision and fetches the event again.
   Any different ETag requires a new proposal and approval.
5. Before PATCH, `dispatching` is persisted. The request sends `If-Match` with the approved
   ETag, `sendUpdates=all` and a private `zhivexOperation` marker, preserving
   other private properties. A 412 produces a conflict without retrying.
6. Confirmation requires verifying the marker and final fields. Repeating a confirmed
   operation returns the stored result without another PATCH.

This reuses [Calendar conditional ETags](https://developers.google.com/workspace/calendar/api/guides/version-resources)
and the notification parameter of [events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).
The result confirms that notification was requested; it does not prove email delivery.

## Recovery and limitations

Credentials and OAuth state are encrypted with AES-256-GCM; the key remains external.
The separate SQLite journal (`state/calendar.sqlite`) and its private permissions
protect proposals, which contain event and attendee data **without encryption**.
The host maintains process exclusion. After a crash, `--recover` only accepts
a dead owner and converts `dispatching` to `uncertain`.

`calendar_read_reconcile` reads Google: if it finds the marker and exact fields,
it confirms; otherwise, uncertainty remains. It never repeats a PATCH after
a timeout. An uncertain operation blocks further modifications to the event.
The MVP requires local inspection when reading cannot resolve it; it has no
button to force resends and does not promise exactly-once delivery in Google.

Title and start/end changes are allowed for normal, individual timed events
organized by the connected calendar. Creating/deleting events,
modifying guests, series, recurring instances, all-day events or events
with incomplete attendee lists are unsupported. Reads are trusted host tools,
restricted to fixed endpoints; writes follow Harness policy.
A policy requiring explicit host review cannot be bypassed through Telegram.

## Evidence

`packages/assistant/tests/calendar.test.ts` covers OAuth/PKCE/state, simulated refresh
and revocation, encryption and wrong keys, rejection of other accounts, expired/tampered
proposals, ETags and 412 races, lost responses before/after PATCH,
journal recovery and absence of resends. The integrated test uses the real host,
persisted Telegram approval, restart of both and event changes before
approval. The OAuth callback is verified with real loopback HTTP.

Google and Telegram APIs and the model are simulated. Consent,
Google project policies and actual notification delivery still require validation with test accounts;
this phase neither deploys nor sends real messages/events.

Local validation 2026-11-10: installed consumer with 29 tests, 149 assertions,
0 failures; typecheck and offline Node example passed. Unpublished Harness candidate 1.6.3,
SHA-256 `37f38a0d090658981b9a085b39f11b8ba37023e608a32ca1c4dbc3f731bbf5b2`.
Architecture, contracts, documentation and `git diff --check` also passed.
