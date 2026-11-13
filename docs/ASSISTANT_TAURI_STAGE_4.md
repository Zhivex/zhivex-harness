# Tauri stage 4: terminal and persistent task operation

Stage 4 extends the existing Assistant application host and Code coding composition.
It does not introduce another agent executor or bypass desktop admission, review, or
checkpoint recovery. The current native preview targets macOS.

## Interactive terminal

The project workspace has a separately labelled human-operated terminal. The Rust
shell owns a real PTY through pinned `portable-pty` 0.9.0; xterm 6.0.0 and addon-fit
0.11.0 load on demand. The authenticated loopback API sends correlated requests over
the existing private parent pipe. No renderer Tauri capabilities or arbitrary native
command invocation are enabled. The host resolves a registered project key to its
canonical directory; the renderer cannot supply a cwd or executable.

The shell is `/bin/zsh -l` with an explicit environment allowlist. Provider credentials,
application bearer tokens, and Node injection options are not inherited from the host.
The user's shell startup files can still configure their own shell environment. This
is a local user shell, not an agent sandbox. Typing commands does not approve agent
operations; existing stage-3 content checks reject stale review/checkpoint evidence
when shell commands change files.

There are at most eight terminals. Each has a 256 KiB output ring, 16 KiB read pages,
2,000 frontend scrollback lines, bounded input, resize, Ctrl+C, and explicit close.
Switching views or hiding the window leaves the PTY alive. Closing a terminal or
quitting terminates ordinary foreground and background jobs in its POSIX session.
Deliberately detached daemons that create a new session are outside this ownership
boundary. Terminal sessions/output are not restored or replayed after process restart.

xterm's generated style elements receive a per-document CSP nonce through its document
override. The application keeps its script policy and does not enable `unsafe-inline`.
OSC 52 clipboard access and automatic terminal link activation are disabled.

## Task lifetime and recovery

- Closing the main window hides it. The native shell and Node host keep running;
  reopening from the Dock reveals the same workspace and activity.
- The Quit menu/Command-Q enters a host-owned decision flow: return to the app, wait
  for active agent work, or request cancellation. Admissions pause before drain/cancel.
  Cancellation can replace a pending drain. Failure to confirm shutdown leaves the app
  available for inspection instead of claiming success.
- This is background execution while the app is alive, not a launch daemon or automatic
  restart service. Parent-pipe EOF and host failure clean up the owned native terminals.
- Existing durable Harness stores reconcile interrupted runs and approvals on restart.
  Uncertain effects are never automatically replayed. The activity queue reads canonical
  `run.get` states rather than relying on session run references.
- The host persists the last project/conversation selection across loopback port changes.
  Restored identifiers are checked against the active profile's registered catalog.
  Terminal processes and unsent drafts are not restored.

Completion/attention notifications are disabled by default. Enabling them requests
actual macOS UserNotifications authorization; delivery uses the native notification
plugin and generic text without project paths or task content. Denied permission stays
disabled. Initial historical activity is not announced as newly completed work.

## Verification

Run `bun run check:assistant`, `bun run architecture:check`,
`bun run --cwd packages/assistant test:desktop`, and
`bun run --cwd packages/assistant build:desktop`.
`smoke:desktop` checks the staged runtime, private URL, lock, shutdown, restart, and EOF.
Pass the final app's `Contents/Resources/runtime` directory to
`scripts/smoke-desktop.ts` to validate the packaged runtime directly.
Run `bun run packages/assistant/scripts/smoke-desktop-settings.ts` to verify that
settings shutdown opens the native decision flow, returning keeps settings usable,
and standalone web shutdown retains its existing behavior. An optional first argument
selects the final bundle's `Contents/Resources/runtime/web/dist` assets.

The offline `scripts/persistent-fixture.ts` can replace `runtime/dist/desktop.js` only
inside a temporary copy of the built app for native acceptance checks. It registers a
temporary repository and uses a delayed mock model; no provider call is made. Never
replace the production bundle's host with a fixture.

Evidence and remaining validation limits are recorded in
[the stage-4 report](reports/TAURI_STAGE_4_2026-11-13.json).

Dependency references: [portable-pty](https://docs.rs/portable-pty/0.9.0/portable_pty/)
and [xterm Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/).
