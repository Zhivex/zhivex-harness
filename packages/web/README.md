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

Only CLI-allowlisted canonical workspaces can be selected. Sessions live in a
drawer, grouped by project when more than one project is open. A single project
has no group headings and no project switcher. `zhivex-code project add`, run
inside the project folder, confirms the full path and writes
`~/.zhivex/projects.json` (mode 0600, or `ZHIVEX_PROJECT_REGISTRY`). A running
`zhivex-code web` process notices the new project without a restart. The browser
never asks for a folder and never opens one. `--state-dir` stays one workspace
and does not load the registry. Removing a project drops the registry entry and
does not delete files. At most eight projects are served; extras stay listed as
Unavailable with a cause and do not stop the others.

The review column is nearly the full width of the workspace. Its position is
Side, Bottom, or Fullscreen, and it can be minimized. The choice is stored in
`localStorage` under `zhivex.code.diffLayout.v1`. Below 1024px, Side is disabled
and the review moves under the chat without overwriting the saved choice.
Light and dark themes follow the system preference until the theme control
picks Light or Dark; that choice is stored under `zhivex.code.theme.v1`.
Brand red is reserved for items that need you. Approve uses the ink button.

Keyboard shortcuts, using `event.code`: Alt+Shift+A approve and Alt+Shift+R
reject only while the review has focus and the button is enabled; Alt+Shift+P
cycles the review position; Alt+Shift+H minimizes it; Alt+Shift+M opens the
model selector (not during a pending review and not from a text field);
Alt+Shift+S favorites the highlighted model; Alt+Shift+J toggles the sessions
drawer; Alt+Shift+N creates a session. There is no single-letter shortcut and
no Ctrl/Cmd+K. Ctrl/Cmd+Enter still only runs the task. Esc leaves fullscreen,
the model popover, or the drawer and never decides.

Existing durable
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
scope, credentials or tool policy. The provider/model control is a searchable popover. Choosing a row applies it
to future tasks in the current workspace. The host catalogue lists non-retired
chat/tool models, including providers that have no credentials; those rows stay
visible and disabled and point at the CLI. Favorites and recents stay in
`localStorage` under `zhivex.code.modelPicker.v1`. Context window and USD price
are shown only when the catalogue publishes them. Images is the only capability
badge unless the catalogue marks vision. It never
writes credentials or changes execution grants. Credential presence does not
verify account access or a model's support tier. Selection is blocked while any
workspace session has an unfinished run, including pending approval; a service
change validates configuration first and preserves existing durable sessions.
An explicit host rejection leaves the model unchanged and keeps session
navigation and cancellation available. A lost response or a failure to read
context after an admitted change requires reconciliation before another action;
the browser never repeats the model change automatically.
Failed attachment attempts restore the previous service or fail closed with
restart guidance. The current custom host model remains visible when absent
from the catalogue. An optional `--tool-policy` selects the existing Harness policy for one
explicit workspace. It is rejected when more than one `--workspace` is passed.
`zhivex-code project add --tool-policy <path>` stores that policy on that
project only. Approvals and policies are not shared across projects. No new
execution policy is introduced.

## Governed task view (CODE-HU-05)

The task/evidence panel sits beside the existing chat. It uses the public
`task.projection.v1` reducer and additive `task.control.v1` host commands;
it has no provider, filesystem, receipt or policy authority. Define a task in
an empty session, inspect contract/check/budget evidence, and request a fresh
host review before accepting, correcting or continuing. See the
[flow, limits and migration guide](../../docs/CODE_WEB_TASKS.md).

## Reuse assessment

The SDK was inspected through connected GitHub, without cloning or modifying it:
[React package](https://github.com/Zhivex/zhivex-ai-sdk/tree/main/packages/react),
`@zhivex-ai/react` 0.9.0. The private Zhivex chat repository was not readable from
this environment. Harness uses HU-21 session/run revisions, exact approval digests
and durable activity pages. `useZhivexChat` and its fetch transport would add a
second state and approval model, so they are not used.

This client reuses `ChatRoot`, `Message`, `Composer`, `ChatEmptyState` and
`ReviewCard` (presentation only, with no decision callback). It does not import
chat hooks, provider clients, or SDK transport. `ReviewCard` cannot require every
file to be viewed or ignore Enter, so the authoritative approve and reject
buttons stay in the change-review panel. The model picker stays local because
0.9.0 does not export one. Desktop's existing `FileDiff`, `applyActivityPage`,
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
