# HU35 — Build-owned update feed and check UI

The build validates and bundles `desktop/update-trust.json`. It is disabled by
default because no production feed, Ed25519 public key or Apple Team ID has been
provided. An enabled configuration is strict and host-owned; IPC accepts no feed,
key, URL or policy arguments. No network request occurs for disabled configuration.

The host performs bounded, credential-free feed requests and verifies the exact
signed envelope. Same-version responses require the same signature/channel/state
checks and cannot become installable artifacts. One request is shared by concurrent
callers, and expired availability is invalidated. Renderer status contains no
artifact URLs, keys, Team ID or underlying error messages.

Main and preload now expose validated status/check operations. The sidebar panel
shows availability, current version, retryable failure and unconfigured status,
and prevents duplicate clicks. It stays inside the existing sidebar. There is no
download/install action yet. React review focused on effect cleanup, synchronous
click exclusion, type-only host imports and accessible status/disabled controls.

Validation:

- Core/desktop TypeScript and packaged build pass.
- Full suite: 808 pass, 4563 assertions across 116 files.
  Log: `/tmp/har-update-feed-suite.log`.
- Fifteen targeted feed/manifest/download tests pass with 132 assertions, including
  disabled no-network behavior, strict trust, current-version authentication,
  unsafe redirects, bounded reads/timeouts, concurrent requests and IPC rejection.
- Packaged renderer fixture verifies every UI state and duplicate click prevention:
  `/tmp/har-layout-F1q1Ax/report.json`. Screenshot visually inspected.
- Four packaged geometry checks at 1120/720px with credential settings open/closed
  pass: `/tmp/har-layout-t594Cs/report.json`.
- Full packaged smoke passes with the real disabled-feed host and expanded bridge:
  `/tmp/har-electron-0p6at0/report`. This includes approval/recovery and renderer
  isolation regressions. An initial run alongside the suite hit its 90-second
  process limit without a result; the same packaged build passed on a serial rerun.
  The timeout's cause was not established and no product fix is claimed for it.

The signed-feed tests use ephemeral fixture keys and mocked HTTP responses. No
production feed or signing identity was invented or contacted. The renderer test
uses fixture IPC responses. The package's real host remains unconfigured.

Remaining: download/install coordination with main, active-work admission and
nonparticipating SQLite clients, production trust values and final signed update
verification. Signature/notarization remain deferred. The app bundle was rebuilt;
the earlier DMG was not regenerated for this increment. No push or publication.
