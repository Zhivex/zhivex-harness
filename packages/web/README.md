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
scope, provider, credentials or tool policy. An optional `--tool-policy` selects
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

Memory PR 160 was inspected read-only. It adds an experimental host API but no
service/protocol operation, and is not in this branch's base. A memory panel is
therefore pending a verified service integration and intentionally omitted.
No TUI or memory changes were imported.

## Security boundary and limits

Loopback HTTP is not automatically secure. The listener accepts only
`127.0.0.1`, refuses nonlocal bind configuration, verifies the exact numeric Host
including port and the peer address, requires same-origin POST plus a custom
header, rejects foreign Origin/fetch metadata, and checks per-session CSRF for
all authenticated routes, including context/reload. This avoids relying on a
localhost cookie that can also be sent to other ports. There is no CORS permission, WebSocket transport, general command
dispatch, arbitrary file API, or browser-controlled runtime configuration.
Upgrade requests are closed. Authentication expires after 12 hours and rotates
on relaunch; pairing cannot be replayed. Provider and private Unix transport
credentials never enter browser assets, responses or launcher logs.

Static assets are an exact startup inventory of regular, singly linked files
with canonical boundary, no-symlink and descriptor/inode checks. Requests do not
resolve filesystem paths. Traversal, encoded paths and unknown files fail closed.
Workspace file operations remain inside the existing engine boundary. Tool/model
text is escaped React text; no raw HTML, remote fonts, CDN or third-party browser
resources are loaded. CSP denies framing, outside connections and inline scripts.

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

## Contributor verification

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
the opener, checks assets/logs and verifies SIGTERM plus restart. It initializes
a synthetic provider credential only in the child environment and sends no task.
