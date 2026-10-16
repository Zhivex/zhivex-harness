# Code changelog

## Unreleased

- Pin `restore_file` to a destination and digest, bind each budget ledger to its source namespace, compare protected paths with locale-independent lowercase, and flag high-entropy output from credential-bearing MCP servers. This note does not publish a release.
- Rework the local web workspace around review: a sessions drawer, light and dark themes, a movable diff panel, and a searchable model selector. `zhivex-code project add` registers a folder for a running local server. Tool policy stays per project. This note does not publish a release.
- Select provisional Amazon Bedrock and Azure OpenAI from the matched engine. Converse uses the AWS credential chain and region and reports Tier B on published Bedrock 2.0.7. The OpenAI-compatible Bedrock runtime and Azure OpenAI can use a keychain or temporary API key with their required https endpoint. Pin Core 1.34.0 with that engine. No live calls, tags, or publication are authorized.
- Add `zhivex-code export-audit <task-id> --out <directory>` and `zhivex-code verify-audit --out <directory>`. Both call the experimental `@zhivex-ai/harness/audit` entrypoint. Verification reads the pack and signing key without resolving provider, store, or budget configuration. This note does not publish a release or change the Harness pin.
- Add a task and evidence panel to the existing local web client: goal, revision, artifact and check provenance, task-wide accounting, and explicit accept, correct, and continue actions. Keep exact tool approvals, cancellation, and chat presentation in their existing surfaces.
- Migration: use the matched experimental Harness `task.control.v1` host. Existing sessions remain readable; ordinary chat has no required task contract. New governed tasks initially require a clean native Git workspace, existing tracked text files, package checks, and explicit token limits. Failed or uncertain effects are never replayed automatically; unknown consumption blocks continuation. No published version or SDK pin changes.

## 0.3.2 - 2026-10-16

- Reuse an equivalent Rekor transparency-log entry when npm provenance generation receives HTTP 409 for the same proposed DSSE entry. The existing entry is fetched and checked for the exact envelope, payload hash, signature, and certificate before the bundle is accepted. Workflow identity and release-commit verification stay in place. The Harness pin remains 1.4.1.

## 0.3.1 - 2026-10-15

- Pin exactly Harness 1.4.1 and Core 1.33.0. Optional `@napi-rs/keyring` moves from 2.1.0 to 2.1.1; a missing entry still reads as absent. Publish only after that engine is verified on `latest`. Published Code 0.3.0 is `latest`. Published Code 0.3.0-rc.8 remains `next`.
- Keep the composer footer readable below 48 columns, say `rejected by you` when an operation is rejected, check the Node engine before startup, and describe command reviews as commands.
- The local browser retries reconciliation when a command finishes during reconnect, and its limits copy is English.
- The matched engine's Vertex transient-failure retry and explicit monetary output caps shipped in Harness 1.4.0 / Code 0.3.0. This patch does not add them.
- This preparation does not authorize tags, paid calls or a campaign.

## 0.3.0 - 2026-10-14

- Published on npm `latest`, pinned exactly to Harness 1.4.0 (`53cdfd338cd33f4786629a30ca7f7a8782ba0ac8`). That engine includes the Vertex transient-failure retry. Explicit monetary output caps above 2,048 were already in the 1.4.0-rc.7 engine. Published Code 0.3.0-rc.8 remains `next`.
- This package is not identical to `code-v0.3.0-rc.8` (`5bba06c86fc82b34b67cec607053948f8e00d0d1`). It includes the review screen shared by shell `--continue` and `/pending` ([PR201](https://github.com/Zhivex/zhivex-harness/pull/201)), the one-line status and summary and the 48×24 first-welcome logo ([PR210](https://github.com/Zhivex/zhivex-harness/pull/210)), and the public package README ([PR200](https://github.com/Zhivex/zhivex-harness/pull/200)). The matched published engine is the 1.4.0 tag, which adds the Vertex retry on top of that rc.8 runtime.
- The interactive console reviews pending approvals on one screen, keeps the idle status and the final summary to one line, and shows the logo on the first welcome of a new session at 48×24.
- This preparation does not authorize tags, paid calls or a campaign.

## 0.3.0-rc.8 - 2026-10-08

- Pin exactly Harness 1.4.0-rc.8 for the matched npm `next` candidate. Retain existing terminal/local browser contracts, the SDK pins already on main (Agents 1.11.0 and Core 1.31.0) and provider/API tiers.
- Carry the engine refusal of a repeated `delegate_*` task in one model response. Published Code 0.3.0-rc.6 remains npm `next`. Annotated Harness `v1.4.0-rc.7` was tagged but not published after live certification failed on Qwen; no Code RC.7 tag was created. Candidate preparation does not authorize tags, paid calls or a new campaign.

## 0.3.0-rc.7 - 2026-10-08

- Pin exactly Harness 1.4.0-rc.7 for the matched npm `next` candidate. Retain existing terminal/local browser contracts, the SDK pins already on main (Agents 1.11.0 and Core 1.31.0) and provider/API tiers.
- Persist bounded guided task token and monetary authority across turns, correction and restart. Persist cancellation before acknowledgement, fence late admissions, and recover continuity from durable authority: keep contract revisions, refuse stale approvals and missing evidence, and revalidate receipts before keep. No automatic effect replay. Ordinary non-task retry stays unchanged.
- Carry optional Web task/project limits, immediate composer consumption and sanitized Qwen stream diagnostics from the matched engine. Published Code 0.3.0-rc.6 remains npm `next` until a separately approved publication. Candidate preparation does not authorize tags, paid calls or a new campaign.

## 0.3.0-rc.6 - 2026-10-05

- Pin exactly Harness 1.4.0-rc.6 for the matched npm `next` candidate containing the reviewed activity projection fix. Retain existing terminal/local browser contracts, published SDK pins and provider/API tiers.
- Preserve the held Harness RC.5 source, tag and campaign evidence; no Code RC.5 tag or publication was started. The new candidate requires a separately approved engine campaign and actual Harness registry integrity/provenance verification before the protected Code gates.
- Retain RC.4 migration requirements, historical model mappings and stable `latest` channels. Candidate preparation does not authorize tags, paid calls or publication.

## 0.3.0-rc.5 - 2026-10-05

- Pin exactly Harness 1.4.0-rc.5 for the matched npm `next` candidate, retaining the published SDK batch and existing terminal/local browser contracts.
- Preserve the failed Harness RC.4 campaign and immutable source. Code publication requires a separately approved engine campaign, actual Harness registry integrity/provenance verification and the existing protected Code gates.
- Retain the RC.4 migration requirements, all historical model mappings and stable `latest` channels.

## 0.3.0-rc.4 - 2026-10-05

- Pin exactly Harness 1.4.0-rc.4 and align Agents 1.10.3/Core 1.30.1 with the matched engine. Publish to npm `next` only after the engine passes its complete protected campaign and registry/provenance verification.
- Preserve published RC.1 artifacts, immutable RC.2/RC.3 failure history, model pins and stable `latest` channels.


- Add experimental direct-chat `/task start`, `review`, `keep` and `revise`: retain a goal, constraints, clean Git baseline and declared native package checks using existing engine run metadata. Reopen with a task recap; require fresh file/diff inspection and a revision check before recording a human keep decision. Keep does not commit or restore files.
- Preserve check evidence separately from agent completion. Emit redacted verification receipts in run JSON and Code run inspection/export; never infer task success from generic receipts.
- Report unavailable or failed Git review truthfully in `/diff`, including repositories without Git. Package task workflow instructions and correct consumer/contributor links.

Migration: existing sessions and run statuses/exit codes are unchanged. Tasks without a brief retain their behavior. Guided tasks initially require a clean Git-visible native workspace, selected existing bounded text files and no subagents; approved checks run on the host. Drafts are saved with the first turn. Web/service guided-task UI, task-wide budgets and automatic worktrees are deferred. Upgrade all workers sharing SDK state together with a complete backup; see the matched Harness changelog for Core 1.30.1 identity and legacy-memory migration requirements.

## 0.3.0-rc.3 - 2026-10-04

- Pin exactly Harness 1.4.0-rc.3 and prepare npm `next` after the matched engine passes its complete protected campaign and registry/provenance verification. Retain the existing RC.2 terminal and local web behavior; the matched engine carries improved routing failure diagnostics.
- Preserve published RC.1 artifacts, immutable RC.2 history and stable `latest` channels.

Migration: Node >=22.13.0, existing sessions, exact approvals and provider support tiers remain unchanged. Project memory and the local browser remain experimental.

## 0.3.0-rc.2 - 2026-10-04

- Retain bounded assistant report context through immediate `/compact` and session restart with the matched Harness candidate; `/clear` resets the context. Recovered text grants no approval or acceptance authority.

- Start the local web launcher with a secure short socket location when the canonical temporary path exceeds Harness's unchanged 100-byte limit. Preserve existing service ownership and fail closed on unsafe or occupied locations.
- Show allowlisted startup reason codes without exposing filesystem paths or configuration secrets.
- Clarify web task, connection and review states, keep unconfirmed actions behind reconciliation, retain tab drafts and improve keyboard/mobile diff review.
- Align the local browser with Zhivex Chat branding, render safe assistant Markdown, and select configured host-issued provider/model choices for future tasks without changing credentials, permissions or pending approvals.
- Keep navigation and cancellation available after a definitive model-selection rejection; require reconciliation for lost or otherwise uncertain mutation outcomes.

- Pin exactly Harness 1.4.0-rc.2 and prepare npm `next`; publish after the matched engine passes its protected gates and registry/provenance verification. Preserve the published RC.1 artifacts and stable `latest` channels.

Migration: Node >=22.13.0, existing sessions and exact approvals remain supported. Assistant recovery remains untrusted; project memory and the macOS/Linux local browser remain experimental. Provider support tiers are unchanged.

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
