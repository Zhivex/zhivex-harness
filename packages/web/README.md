# Local Code browser workspace

Run `zhivex-code web` from a repository. The installed Code package contains the
compiled React + TypeScript + Vite assets and a small Node host; users do not
install Vite or run a frontend build. macOS/Linux, Node 22.13+ are supported by
the existing Unix Harness transport. This is an experimental local Code client.

```sh
zhivex-code web
zhivex-code web --workspace /projects/atlas --workspace /projects/beacon
zhivex-code web --profile default --port 3210
zhivex-code web --help
```

The launcher reads the existing CLI default/profile and credentials from the
launching environment or existing OS secure store. It never asks the browser
for credentials, creates a credential entry, or sends provider requests during
startup. If credentials are missing or locked, configure/unlock them using the
existing CLI and restart. The launcher opens the browser with a single-use,
two-minute capability in its fragment, removes it before rendering, then uses
an in-memory HTTP session and HttpOnly SameSite=Strict cookie. The CSRF secret
is retained only in origin/port-bound tab sessionStorage for reload; cookies
alone cannot recover the session. A new unrelated tab must be paired again. The terminal
prints only the base URL. If browser opening fails, startup shuts down with
`WEB_BROWSER_OPEN_FAILED`; fix the OS opener and relaunch. `--no-open` is for
supervision; it intentionally does not print a pairing capability.

Only CLI-allowlisted canonical workspaces can be selected. Existing durable
sessions can be selected and resumed after a reload/relaunch. The task stream
uses Harness activity pages with atomic cursors, deduplication and expired-cursor
snapshot recovery. A lost command response is reconciled by reading state,
never by submitting a new mutation automatically. A disconnect leaves admitted
work running; Cancel uses the existing run cancellation operation. Ctrl+C or
SIGTERM blocks admission, requests active cancellation, drains accepted work
and closes the service. A crash requires explicit `--recover`, which delegates
to the existing dead-owner proof and does not replay mutations.

The UI exposes task start, session creation/selection, exact pending approval
review, full file diff and payload, approve/deny, cancellation, applied diffs,
tool activity, check exit codes and sanitized errors. New sessions take their
title from the first task. If an early engine/provider failure leaves no readable
run state, the UI marks it unavailable, preserves its recorded activity and
requires reconciliation or a new session rather than showing an older run.
Check success uses exit
code zero and absence of timeout; a successful tool transport alone is not a
passing check. Browser-selected IDs and revisions never override host workspace,
scope, credentials or tool policy. The provider/model picker applies an explicit
selection to future tasks in the current workspace using a host-issued catalogue
of non-retired chat/tool models and existing configured credentials. It never
writes credentials or changes execution grants. Credential presence does not
verify account access or a model's support tier. Selection is blocked while any
workspace session has an unfinished run, including pending approval; a service
change validates configuration first and preserves existing durable sessions.
Failed attachment attempts restore the previous service or fail closed with
restart guidance. The current custom host model remains visible when absent
from the catalogue. An optional `--tool-policy` selects
the existing Harness policy on the host. No new execution policy is introduced.

## Reuse assessment

The SDK was inspected through connected GitHub, without cloning or modifying it:
[React package](https://github.com/Zhivex/zhivex-ai-sdk/tree/main/packages/react),
`@zhivex-ai/react` 0.6.2. Its `useZhivexChat`, reducer and fetch transport use
`UIMessage`/chat chunks, chat replay cursors and SDK approval responses. Harness
uses HU-21 session/run revisions, exact approval digests and durable activity
pages. Adapting the hook would add an unnecessary second state/approval model.

This client reuses only SDK `ChatRoot` and `Message` for presentation of sanitized
plain text. It does not import chat hooks, provider clients, SDK approval cards
or SDK transport. Desktop's existing `FileDiff`, `applyActivityPage`,
`projectApprovalReview`, `ReviewTickets` and renderer redactor are reused unchanged.
They are bundled at build time; Electron and Desktop credential/OS bridges are
not runtime dependencies. The host uses only declared Harness `/engine`,
`/protocol` and `/service` exports, plus Code's existing read-only credential
and profile helpers.

The merged main includes project memory (PR 160) and the compact terminal flow
(PR 161). Memory adds an experimental host API but no service/protocol operation.
A browser memory panel remains pending a verified service integration. The web
client continues to use the existing Harness contracts and its own presentation.

## Security boundary and limits

Loopback HTTP is not automatically secure. The listener accepts only
`127.0.0.1`, refuses nonlocal bind configuration, verifies the exact numeric Host
including port and the peer address, requires same-origin POST plus a custom
header, rejects foreign Origin/fetch metadata, and checks per-session CSRF for
all authenticated routes, including context/reload. This avoids relying on a
localhost cookie that can also be sent to other ports. There is no CORS permission, WebSocket transport, general command
dispatch or arbitrary file API. Browser model choices are limited to host-issued
configured provider/model pairs; workspace, scope, tool policy and credentials
remain host-owned.
Upgrade requests are closed. Authentication expires after 12 hours and rotates
on relaunch; pairing cannot be replayed. Provider and private Unix transport
credentials never enter browser assets, responses or launcher logs.

Static assets are an exact startup inventory of regular, singly linked files.
The existing public Harness host read primitive rejects symlink ancestors,
opens nonblocking, bounds positional reads, and checks identity, length and
timestamps after EOF. The inventory also rejects path replacement after the read.
Requests do not
resolve filesystem paths. Traversal, encoded paths and unknown files fail closed.
Workspace file operations remain inside the existing engine boundary. Tool/model
text uses escaped React rendering. Assistant messages render Markdown headings,
lists, tables and code using the same Markdown libraries as Zhivex Chat; raw HTML
is skipped, unsafe link schemes are removed and external images become text
placeholders. Links open separately with noopener/noreferrer. The authentic
Zhivex icon and Chat dark/purple palette are bundled locally. No remote fonts,
CDN or third-party browser resources are loaded. CSP denies framing, outside connections and inline scripts.

Review tickets are scoped to one authenticated browser identity and workspace,
expire, and are consumed before dispatch. Only a complete supported Desktop
projection can authorize a positive decision. Harness then validates revision,
full approval set/digest, expiry, signed action and workspace preconditions.
A stale, replayed or uncertain decision needs a fresh review/state read.
A user with control of the same OS account/processes can access local state;
this client does not isolate mutually hostile local users or certify all engine
persistence as a sanitized export. Serve one owner per workspace/scope; running
a parallel direct CLI writer is unsupported by the existing exclusive-owner
contract. Worktrees, delivery/PR actions and credential management are outside
this bounded MVP.

The pairing exchange and browser-session cookie travel over unencrypted
loopback HTTP. The cookie seals the internal random session identity with
AES-256-GCM, a fresh nonce and an in-memory per-launch key; the exact origin/port
and cookie name are authenticated as associated data. The host rejects plaintext,
tampered and cross-launch values and destroys its key on shutdown. The cookie has
no persistent lifetime attribute and expires server-side after 12 hours or shutdown.
Cookie encryption protects stored contents; it does not prevent bearer replay
or encrypt HTTP traffic.
Host/origin/CSRF checks constrain browser access; they do not provide confidentiality
against a compromised OS account or a process able to observe loopback traffic.

## Contributor verification

The launcher checks the canonical Unix socket path before starting Harness. If
the temporary path is too long and its private service directory is empty, it
uses an owner-private directory under `/tmp`. Owner, mode and final-directory
symlink checks still apply; the Harness 100-byte limit is unchanged. Existing
state in an overlong preferred location produces `WEB_SERVICE_LOCATION_OCCUPIED`
instead of being moved or recovered automatically. Startup failures expose only
allowlisted reason codes, such as `PERMISSION_DENIED` or `SERVICE_STATE_EXISTS`,
never the original filesystem/configuration error. Browser opener failures remain
`WEB_BROWSER_OPEN_FAILED` and can be separated with `--no-open`.

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun install --cwd packages/code --frozen-lockfile --ignore-scripts
bun install --cwd packages/web --frozen-lockfile --ignore-scripts
bun run --cwd packages/code build
bun run --cwd packages/code typecheck
bun run --cwd packages/web typecheck
bun run --cwd packages/web lint
bun test packages/web/tests
bun run --cwd packages/code test
packages/web/node_modules/.bin/playwright install chromium
bun run --cwd packages/web test:browser
node packages/web/scripts/installed-smoke.mjs
```

`WEB_BROWSER_PATH=/usr/bin/chromium` can select an existing browser. Browser and
installed reports/screenshots go to `.test-output/` (ignored). Fixtures use the
real published Harness dependency with offline model doubles; no paid/live
provider tests run. The installed smoke packs Code, installs with npm and
lifecycle scripts disabled, starts the real installed command and pairs through
the opener, checks assets/logs, exercises configured model selection without any
provider request and verifies SIGTERM plus restart. It initializes
a synthetic provider credential only in the child environment and sends no task.

Review evidence must include the exact commit's check runs and code-scanning
conclusion. GitHub Advanced Security's CodeQL check is separate from the Actions
analysis job: the workflow can finish successfully while an open alert fails the
security check. Verify its summary and accessible PR alert state; resolving a
review thread does not fix or dismiss a code-scanning alert. Record any source
that could not be accessed.

### State, drafts and recovery

The task stream distinguishes loading, disconnection, unreadable run state and
an unconfirmed command response. Reconnect reads context, sessions and the
latest run before enabling another mutation. It does not resubmit tasks,
decisions or cancellation requests. A failed start retains its editable draft;
drafts are kept only in this tab's memory, scoped to each workspace/session,
and are lost on reload. During a long host response, activity keeps updating
and active cancellation remains available.

Pending review has a keyboard-accessible jump link on narrow layouts. Loading
an exact review focuses its heading; Next change focuses the changed diff
block. Stale, expired or disconnected reviews disable both decisions and explain
how to obtain a fresh review. The host still enforces the exact pending set,
revision, digests and single-use ticket. Search and connection status remain
available on mobile. Offline browser acceptance covers response loss after
admission, repeated activation, stale/expired review, reconnection, cancellation,
draft isolation and layouts from 320 to 1440 pixels.
