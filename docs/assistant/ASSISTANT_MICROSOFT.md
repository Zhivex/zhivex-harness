# Microsoft 365 / Outlook in Assistant

The local, single-owner Assistant can connect to a Microsoft 365 work account in
the global Microsoft cloud. Uses delegated OAuth authorization code + PKCE and
a loopback callback; no client secret, application permissions, password handling,
or public gateway is required.

## Entra ID configuration

1. Open [Microsoft Entra admin center](https://entra.microsoft.com/) → Identity →
   Applications → App registrations → New registration.
2. Name the app `Zhivex Assistant`. Select **Accounts in this organizational
   directory only** (single tenant).
3. Under Authentication → Add a platform → **Mobile and desktop applications**,
   add exactly `http://localhost/oauth/callback` as a custom redirect URI.
   Assistant listens on an ephemeral loopback port. Entra ignores the port for
   localhost redirects; the path must match. Register it as a public/native client,
   not Web or SPA. Do not enable implicit access-token or ID-token grants.
4. Under API permissions → Add a permission → Microsoft Graph → **Delegated
   permissions**, add:

   | Permission | Purpose |
   | --- | --- |
   | `User.Read` | Identify the signed-in account |
   | `offline_access` | Renew the session while Assistant is running |
   | `Mail.ReadWrite` | Read mail and create drafts (omit for calendar-only agents) |
   | `Calendars.ReadWrite` | Read the default calendar and create personal appointments (omit for mail-only agents) |

   `Mail.ReadWrite` is the least privilege supported by Graph for creating drafts;
   it is broader than the tools Assistant exposes. **Do not add `Mail.Send`.**
   No Application permissions are used. No client secret or certificate is needed.
5. Ask your administrator to grant consent if user consent is restricted. MFA and
   Conditional Access policies still apply. The user needs an accessible Exchange
   Online mailbox. Government/China clouds and on-premises Exchange are not covered.
6. Copy **Application (client) ID** and **Directory (tenant) ID** from Overview.

References: [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url),
[create a draft](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0),
[create an event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0).

## Connect from the interface

1. Rebuild/restart Assistant to load this version.
2. Add an agent (or finish configuring a new one), select its model, then open
   **Herramientas → Microsoft · Outlook empresarial**.
3. Paste the two IDs, choose mail and/or calendar, and select **Autorizar en
   Microsoft**. Open the authorization link, sign in and consent in your browser.
4. Wait until the account email appears, then start the agent.
5. **Configuración → Integraciones** shows the account and enabled capabilities.
   Select the agent and use **Volver a autorizar Microsoft** if consent expires or
   is revoked. Finish/cancel pending runs and pause daily automation first. The host
   pauses during login and resumes with the same profile/account afterward.

Examples: “Mostrame los últimos correos no leídos”, “Leé este correo”, “Prepará un
borrador para ana@empresa.com con este texto”, “Qué tengo mañana en el calendario”,
“Creá un bloque personal mañana de 9 a 10, hora de Buenos Aires”. The model must
resolve dates and explicit UTC offsets before requesting a calendar write.

A single agent supports one agenda source: Google Calendar **or** Outlook. Gmail
and Outlook mail can coexist. Existing agent tool catalogs remain immutable; use a
new agent to add Microsoft to an older agent. Reauthorization preserves the same
Microsoft account and tool catalog. Changing account, tenant or capabilities
requires a new agent. During new-agent setup, **Desconectar Microsoft** removes
local tokens and permits choosing another account. It does not revoke Entra consent;
remove that grant in your organization's application/consent management if needed.

## Behavior and boundaries

- Mail: list/search/read messages with bounded content and pagination; create new
  plain-text drafts with To and CC. No sending, attachments, threaded reply action,
  deletion, or arbitrary Graph requests.
- Calendar: read occurrences in the default calendar (also used by the web agenda
  and daily summary); create personal appointments with subject, text, location,
  start and end. No attendees/invitations, update/delete, shared calendars or
  recurring-event authoring in this version.
- Writes use the existing Harness human-approval path. The model first prepares a
  durable, encrypted proposal. The host displays its exact recipients/body or event
  fields for review. Only its request ID and digest cross the approval/resume
  boundary, preserving content across restart. Proposals expire after 15 minutes;
  editing a proposal requires a fresh ID and approval.
- Durable write receipts prevent redispatch of an operation after success,
  uncertain network results or restart. Use `operation_status` to inspect a receipt.
  If the outcome is uncertain, check Outlook manually; never compensate by creating
  a new request. Event creation also supplies Graph's `transactionId`.
- OAuth refresh is serialized. Credentials are encrypted in the private module
  database; the encryption key is stored with managed configuration in the system
  keychain. No tokens are returned by setup state or placed in model instructions.
- Account, tenant, connection and scopes bind the module to the agent. Pagination
  uses opaque, query-bound handles and restricts URLs to the expected Graph endpoint.
- API throttling/errors are surfaced without automatic write retries. Continuous
  operation requires Assistant to remain running. No email push subscriptions.

The embedded TypeScript API exports `openMicrosoftConnection`,
`startMicrosoftAuthorization` and `createMicrosoftModule`. The managed UI is the
supported onboarding path; no Microsoft CLI login or declarative config has been
added in this change.

## Validation

Use Bun:

```sh
bun run --cwd packages/assistant typecheck
bun run --cwd packages/assistant test
bun run --cwd packages/assistant smoke:microsoft-web
```

Tests use simulated Microsoft HTTP responses and real local callback/host servers.
They cover consent/state, refresh/revocation, account changes, encrypted storage,
pagination restrictions, exact draft/event payloads, offset conversion, uncertain
writes/restarts, managed setup and reauthorization. Browser smoke covers the new
form, callback, connected status and mobile layout. A live tenant pilot remains
necessary to certify your organization's consent and Conditional Access policies.
