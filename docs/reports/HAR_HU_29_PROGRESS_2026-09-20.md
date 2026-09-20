# HU29 — complete file review increment

Status: in progress. No acceptance checkbox is closed by this report.

The service supports opt-in run.get includeReview. It derives complete UTF-8
preimages from the exact pending proposal through protected descriptor reads,
checks the expected digest and returns before/after bytes and destination digests.
The desktop binds these previews to its existing one-use approval receipt. Stale,
protected, invalid UTF-8, too-large or redacted content disables positive approval.
Supported file tools: apply_patch, apply_reviewed_edits and
apply_reviewed_replacement. run_check remains reviewable and approvable.

The packaged macOS arm64 app was exercised through the real React buttons. Reject
preserved the fixture file. A subsequent run was reviewed and approved, writing
exactly the displayed CRLF-preserving destination. HTML-like repository text was
literal and created no image element. Evidence is in
HAR_HU_29_PACKAGED_2026-09-20.json and HAR_HU_29_REVIEW_2026-09-20.png.

This exposed a real continuation defect: rejected tool calls without recorded
results could become pending again in the following run. Terminal continuations now
insert an explicit unknown-outcome context record; they never fabricate successful
effects or authorize replay. Error checkpoints report persisted failure status.

Validation: 645 tests passed, 0 failed, 3671 assertions across 85 files. Root and
desktop typechecks, tooling typecheck, documentation and contract checks passed.
The Stable API signature snapshot was reviewed for additive Workspace preview
methods and their transitive signatures. No existing method was removed. The
optional client request field is reflected in the JSON Schema.

The final unsigned package smoke passed from a temporary working directory with
bundled Electron/Node and offline model fixtures. This is not a signed/notarized
release, a published artifact or a live-provider certification.

Remaining HU29 work: durable per-decision/effect history distinguishing rejected,
failed and applied; check evidence tied to exact patches; OCI patch and mode review;
packaged stale-client and expiration scenarios. HU30–35 remain open in the main
plan. No release or push was performed.
