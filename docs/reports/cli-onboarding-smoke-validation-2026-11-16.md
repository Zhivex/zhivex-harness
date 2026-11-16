# CLI onboarding smoke correction — 2026-11-16

The onboarding PTY smoke waited for literal `\n> ` bytes, but Node readline
places ANSI cursor-position and erase sequences between the newline and prompt.
The matcher now accepts CSI and cursor save/restore sequences between marker
bytes, including sequences split across PTY reads. It consumes through the raw
match offset and retains the original output for secret and rendering assertions.
EOF fails immediately; the existing timeout is unchanged.

Once prompt detection worked, the smoke exposed stale UI expectations. Credential
sources are now checked through `/status`; approval-policy and token-budget labels
match the current console. The edit flow uses the full-screen review's `d` and `a`
actions, verifies the technical payload, checks that no file exists before approval,
and checks the exact written contents afterward. Production code is unchanged.

## Validation

On macOS ARM64 with Node 24.11.0 and the local built CLI:

- `python3 scripts/console-entry-smoke.py`: passed, including onboarding, hidden
  credentials, saved profiles, provider selection, context/approval modes,
  connection probe, command search, history, queued input, recovery, reviewed
  writes, JSON TTY output, service startup and Ctrl+C.
- `python3 scripts/console-pty-smoke.py`: passed, including literal paste,
  navigation, resize, attachments, interruption, partial stream failure,
  history recovery, paste-safe approvals, approval restart, edits and exit.
- A focused matcher probe passed for plain prompts, cursor/erase sequences,
  styled prompts and fragmented reads, checking raw-byte and pending-tail preservation.
- `git diff --check`: passed.

Both smoke scripts use process-local fetch fixtures and isolated temporary state;
these results do not represent live provider calls. The complete unit suite was
not rerun for this smoke-only correction.
