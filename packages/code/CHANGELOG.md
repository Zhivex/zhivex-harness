# Code changelog

## Unreleased

- Retain bounded assistant report context through immediate `/compact` and session restart with the matched Harness candidate; `/clear` resets the context. Recovered text grants no approval or acceptance authority.

- Start the local web launcher with a secure short socket location when the canonical temporary path exceeds Harness's unchanged 100-byte limit. Preserve existing service ownership and fail closed on unsafe or occupied locations.
- Show allowlisted startup reason codes without exposing filesystem paths or configuration secrets.
- Clarify web task, connection and review states, keep unconfirmed actions behind reconciliation, retain tab drafts and improve keyboard/mobile diff review.
- Align the local browser with Zhivex Chat branding, render safe assistant Markdown, and select configured host-issued provider/model choices for future tasks without changing credentials, permissions or pending approvals.

## 0.3.0-rc.1 - 2026-10-04

- Add experimental local project-memory commands and per-invocation `--no-memory`. The feature uses the exact matched Harness candidate.

- Introduce compact terminal conversation flow and pageable, exact approval review.
- Ship `zhivex-code web` with prebuilt browser assets, loopback pairing, durable sessions and the governed Harness service. No frontend build is required after installation.
- Pin exactly Harness 1.4.0-rc.1 and target npm `next`; publish only after the matched engine is verified. Stable `latest` stays at 0.2.0.

Migration: Node >=22.13.0 remains required. Existing state and approvals remain supported. Project memory and the macOS/Linux local browser remain experimental; the browser has no project-memory management panel. No provider support tier is promoted.

## 0.2.0 - 2026-10-03

- Show per-file changed-region diffs for reviewed local edits using Harness
  precondition-validated previews; approvals and apply-time checks remain required.
- Add reviewed checkpoint capture, review and restoration on Harness 1.3.0 APIs.
  Restoration requires two explicit reviews, preserves the original conversation,
  and rejects stale preconditions and partial-operation retries.
- Show advisory catalog pricing and configure estimated USD limits per new run.
  Resumed runs retain their original policy; estimates are not invoices or
  guaranteed financial caps. Synthetic tutorial rates are not provider prices.
- Ship a Node-only offline first-use tutorial with deterministic transport fixtures.
- Correct release inspection to admit exactly the two tutorial modules and reject
  arbitrary payloads. Require exact-main installed journeys and test the retained
  release tarball in an offline PTY without repacking it.

Migration: the sole binary remains `zhivex-code`; Node >=22.13.0 and the exact
`@zhivex-ai/harness@1.3.0` dependency remain required. Existing persisted sessions,
approval semantics and provider support tiers are unchanged. Monetary defaults
apply to each new run, not the entire conversation.

## 0.1.0 - 2026-10-02

- First verified stable release on npm `latest`, pinned to Harness 1.3.0.
- Independent Node terminal product with provider selection, durable approvals,
  continuation, credentials and installed acceptance across four package managers.
