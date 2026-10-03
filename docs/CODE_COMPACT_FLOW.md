# Code compact terminal flow (unreleased)

The local Code console keeps its flowing conversation and adds a small working
status dock. It shows the selected model, recorded per-run cost estimate and its
original limit, the next-run limit, retained conversation tokens and attachments,
current phase, elapsed time, step and draft/queue state. Context excludes request
instructions and tool schemas. Missing monetary estimates remain unknown; a
limit is an estimate-based runtime policy, not a guaranteed invoice ceiling.
While a request is in flight, the live run total stays unknown/incomplete until
its usage receipt arrives; a previously confirmed zero is not shown as its cost.

Reviewed local file changes open a transient terminal review screen with the
validated diff first. The complete payload, original input digests and preview
identity remain available under **View technical details**. Unknown tools and
unavailable previews retain their complete payload. The review does not alter
engine precondition, digest, execution or verification checks.

- Arrow keys or Tab select a decision. Enter confirms it; Reject is initially
  selected, including after returning from technical details.
- PgUp/PgDn scroll the review body while decisions remain visible. Code syntax
  wraps without dropping characters at 44 columns.
- Typing filters decisions. Bracketed paste and background drafts cannot answer
  an approval. Escape and Ctrl+C leave the complete batch pending.
- An exact check grant remains bound to the workspace and complete script, and
  becomes active only after every approval in the batch has been resolved.

The normal transcript returns after review. Readline task history, multiline
input and literal queued tasks retain their existing controls. Compact activity
groups and the bounded `/activity` history remain available; `/verbose` exposes
the existing detailed stream. Small/dumb terminals use the existing text picker.

Completion reports conversation status, file mutation receipts observed in the
current operation, other tool errors and rejected decisions separately. Only
recorded command receipts establish verification coverage. A restored run uses
its original ledger policy. A checkpoint conflict retains its original digests;
the console points to inspection and a fresh review or manual recovery instead
of refreshing authorization on retry.

This change is confined to `packages/code` terminal presentation and tests. It
adds no memory subsystem, web interface, provider requests, dependencies, package
version changes or release. The standalone Harness CLI and JSON/JSONL automation
interfaces retain their presentation and schema contracts.

Validation uses the existing offline provider fixture and an npm-installed Code
tarball with published Harness 1.3.0. Installed journeys cover 44/80/110-column
reviews, task/check decisions, literal clipboard safety, pending restart/resume,
unknown costs, Ctrl+C/continuation, checkpoint conflicts and a fresh restore.
