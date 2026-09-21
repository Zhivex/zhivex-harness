# HU34/HU35 — Installed worker staging

The application now includes `Contents/Resources/update-worker-entry.cjs` outside
ASAR. The installer preparation checks that it equals the bundled build and records
its SHA-256. The installed-copy check verifies those bytes after copying from DMG.

`createDesktopUpdateWorkerStager` verifies the installed source application, reads
the worker resource without following links, verifies the source again and publishes
an immutable private copy named by SHA-256 outside the app. Publication never
overwrites an existing worker. Before launch it rechecks staged bytes and source
identity/resource content. The launcher still requires its native lock and inherited
state leases. Staging handles are host-held and cannot be fabricated through a
plain object. No production main or renderer route invokes staging yet.

Validation:

- 803 full-suite tests pass, 4536 assertions across 115 files; core/desktop
  TypeScript checks pass. Log: `/tmp/har-staged-worker-suite.log`.
- Four new tests cover immutable reuse, source rejection/change, public staging,
  symlinks, modified staged bytes and fabricated handles.
- The rebuilt app passes four packaged layout checks at 1120/720px with credential
  settings open/closed: `/tmp/har-layout-XyeWfr/report.json`.
- A temporary installation with DMG detached passes the full renderer/runtime,
  approval/recovery, Keychain helper and native handoff checks.
- The worker is staged from that installed copy, then launched with its installed
  Electron/helper. It acknowledges the host, waits for exit, rejects unsigned
  destination bundles and preserves app/data with recovery armed. Evidence:
  `/tmp/har-production-worker-report-REMgU4/report.json`.

The source application is unsigned, so the successful staging test injects a
fixture source verifier. Production staging defaults to Developer ID/notarization
verification. The launched production worker retains its real destination verifier.
This does not demonstrate a signed successful update, Gatekeeper distribution, or
the final user-facing update flow. All runtime tasks/data are temporary fixtures.

Refreshed unsigned DMG SHA-256:
`c4dc1717f2b3d7c38f3c0204f45e3aabf6a883bea299deea6304fd72bce8b1a8`
(142137043 bytes). Worker resource SHA-256:
`829289cbb0985be59a460b00fe7d46861f5d41779d4798ab7a7935d6a2af674e`.
The adjacent MANIFEST/CHECK files preserve the complete artifact hashes and results.
The manifest records source reference `3771772` with a modified worktree; that
reference alone is not a claim of exact source identity for all candidate bytes.

Remaining: main/UI coordination, feed/trust configuration, nonparticipating SQLite
clients and final update UX. Developer ID/notarization remain deferred. No push or
publication; HU34/HU35 acceptance stays open.
