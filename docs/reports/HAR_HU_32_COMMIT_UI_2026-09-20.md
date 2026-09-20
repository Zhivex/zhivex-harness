# HU32 — local staging, review and commit UI

In progress: this adds local delivery controls to the desktop. Push and PR actions
and remote failure recovery are not implemented by this increment. All three
acceptance criteria remain open until the complete delivery flow is verified.

The UI lists allowed changed paths and separately identifies staged and unstaged
content. Explicit whole-file staging builds a temporary index and replaces the
current index under its normal lock only if the original bytes are unchanged.
Existing staged content is never implicitly overwritten; selected unsafe content
fails before installation of any selected entry. Git filters, hooks and external
diff drivers are disabled. Complete UTF-8 previews and recognized-secret checks
retain the manager's bounds; they are not universal secret detection.

The review displays all staged files, exact before/after contents and modes,
message, branch, parent commit, author/committer and local destination. Changes to
selection/message dismiss the review. Authorization sends only the known project
and one-use review ID. Main validates IPC shape/sender, pauses runtime admission,
refuses active work and coordinates task removal/shutdown with Git mutations.

A lost commit response leaves an operation ID in browser local storage. Reloading
preserves it; explicit reconciliation reads the private host record without
reexecuting the commit. A verified absent record permits a new review; an unknown
outcome remains pending. No contents, credentials or commit messages are saved in
browser local storage. Host launch controls the response-loss fixture; the renderer
cannot request a fault or bypass review.

Validation: 681 tests passed, zero failures, 3879 assertions across 91 files.
The eight Git manager tests include atomic staging rejection, preservation of
pre-existing staged/unstaged/untracked data, literal bytes without clean filters,
deletions, stale reviews, locks, conflicts, secret/path/binary refusal, restart and
commit reconciliation. Root/desktop types, docs and stable contracts pass.

The unsigned macOS arm64 packaged worktree journey exercises visible staging,
full review, explicit local commit, a deliberately lost completion response,
renderer reload and reconciliation. It also verifies simultaneous task runtimes,
rejection of Git mutation while running, whole-application restart, independent
files/sessions and reviewed cleanup. No network, provider, push or PR is used.

The first general desktop regression reached its 90-second process deadline while
other verification was running. A subsequent sequential run passed the full general desktop regression, including
review, cancellation, orphan recovery, renderer reload, expired/stale decisions,
keyboard navigation and project isolation. The timeout is retained as a failed
attempt; it is not evidence of success or a diagnosis of its cause.

Final archived evidence: `HAR_HU_32_COMMIT_UI_PACKAGED_2026-09-20.json` and
`HAR_HU_32_COMMIT_REGRESSION_2026-09-20.json`. The worktree driver verifies exactly
one added commit on the selected task branch, with the original branch and sibling
branch unchanged, before and after app restart. Application-code ASAR identity is
in `HAR_HU_32_COMMIT_CANDIDATE_2026-09-20.json`; it is not a signature or a hash of
the whole Electron distribution. No push, publication or remote PR was performed.
