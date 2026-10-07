# Code web tasks — CODE-HU-05

Canonical story: https://app.notion.com/p/3ef777b104f681309854c8f1e73803f1.
Stacked source base: HAR-HU-73 / PR194, commit
`408e141796b5dd1aaa286af09e6851a517725608`. This work extends the existing
PR167 browser in `packages/web`, packaged by `packages/code`; it does not create
a second client, an IDE, a file tree, an SDK patch or a release.

## Operator flow

1. Open `zhivex-code web`, select an allowed workspace and create an empty session.
   Choose **Define task**. Enter the goal, exact existing editable files, package
   checks and explicit input/output/total token limits for the entire task.
2. Review each proposed edit/check through the existing exact approval controls.
   Execution, deterministic checks and human acceptance remain separate statuses.
3. Open **Result, checks and provenance** for paths, contract/current-byte identity,
   required checks and human requirements. The renderer displays host evidence;
   assistant prose does not establish a passing check or permission.
4. Open **Task budget and continuation** for confirmed usage, reservations,
   unknown held exposure and remaining tokens. The account covers all task turns;
   do not add its values to the existing per-run monitor. Missing pricing stays
   unknown; monetary values are estimates, never invoices.
5. Choose **Review task** to obtain a bounded fresh Git diff and a five-minute
   review ticket. Explicitly acknowledge the diff and requirements before
   **Accept this snapshot**. This records operator acknowledgement separately
   from engine checks; it does not commit, merge or assert measured quality.
6. **Correct requirements** adds a pending requirement without a model call.
   **Continue task** requires another explicit instruction and confirmation.
   Both preserve the original account; continuation may consume its remaining
   credit for model/compaction work, approved edits and checks. Back, Escape,
   Close, reload and reconnect do not execute work.

## Interruption and handoff

Cancel initially means requested, not confirmed. A confirmed local cancelled run
does not prove provider termination. Missing provider usage retains unknown
exposure and blocks continuation. A lost/failed command response requires reading
state through Reconnect; it is never automatically retried. Relaunch reopens the
same durable task, contract, checks, budget and effects without depending on the
chat transcript or claiming human minutes.

The runtime records the first interruption source while relaying its signal;
nested cancellation signals cannot change a caller cancellation into an
unclassified failure. It settles local interruption only after the execution
owner releases its lease. The session index can observe `cancel_requested`
directly from `created` when busy reads have not yet observed `running`.
Neither change confirms provider termination or releases unknown exposure.

A continuation rejected before admission retains a failed session attempt linked
to its previous admitted task. The panel explicitly identifies retained evidence;
checks stale against changed bytes cannot authorize acceptance. The rejected
attempt does not fabricate budget admission or consumption. A fresh review targets
the observed admitted run and must satisfy current host checks again.

## Authority and limits

- The browser sends a bounded operator brief, never a contract, receipt, policy,
  credential, ledger or execution grant. The host resolves package checks and
  compiles the existing task contract.
- Initially native Unix workspaces only: clean Git baseline, selected tracked
  visible files (at most 20, each at most 64 KiB), at most eight package checks,
  no subagents. Existing exact edit/check approvals remain mandatory.
- Reviews bind browser identity/workspace, service connection, session, run
  revision, contract, snapshot, budget revision and Git identity. They are
  one-use and expire after five minutes. Account exclusion plus run CAS protects
  acceptance; continuation rechecks admission after host preparation.
- Git failure, process-output truncation, oversized review, hidden files,
  missing/changed receipts or uncertain effects fail closed. The diff is plain
  escaped text with host-path/secret redaction. Redacted or truncated review
  content disables acceptance. No arbitrary file-reading route
  or generic browser command dispatcher is added.
- The existing public projection reducer ignores duplicate/older snapshots,
  rejects changed epochs/scopes and requests refresh for conflicts. Task reads
  are sequential and cancelled on selection changes. Existing activity cursor
  expiry recovery is retained; no activity event grants mutation authority.
- Ordinary chat remains available in ordinary sessions. Once task authority is
  retained, `run.start` cannot bypass task continuation/accounting. Older hosts
  without negotiated controls show an unsupported state.

## Offline acceptance and reproducibility

The frozen HU75 greeting fixture remains SHA256
`473a9e2144b0042b1b46ef54f915de693045df89d6175bde42a3393d2b083263`.
`packages/web/scripts/task-browser-journey.mjs` drives actual packaged Code and
Chromium at desktop/mobile sizes. Its preload replaces provider fetch with a
synthetic transport and blocks every other fetch; it does not fabricate SDK
state, tool receipts or check outcomes. `node check.mjs` and exact approvals run
through the real host/service/engine. This is automated operator input, not a
human pilot or semantic-quality measurement.

The integrated installed runner binds clean source, exact Harness/Code tarball
hashes and their shared installed engine. It runs the existing recovery/projection
consumers plus the Code UI journey, then verifies hashes and cleanup. Preserve
all initial failures separately; only final reports for the exact reviewed SHA
certify that candidate. Browser fixtures cover normal acceptance, multiple tabs,
obsolete review, edit/back/Escape, explicit continuation/double click, workspace
switch, unknown usage on cancellation, reload and process restart. Existing Web
security/browser gates and projection reducer tests cover host/CSRF/path boundaries,
expired cursors, stale epochs, reordered/duplicate pages and unavailable evidence.

Run the source suites and existing browser regression before the installed runner:

```sh
node scripts/code-task-ui-installed.mjs /absolute/harness.tgz /absolute/code.tgz /absolute/node /absolute/evidence
```

The runner requires a clean source checkout and uses an explicit exact candidate
engine override in its isolated npm consumer; published pins remain unchanged.
Use `CI=1`, `umask 022` and the repository-required test policy root. Human minutes,
real quality, real costs and external-team outcomes remain unmeasured. A real
3–5-team pilot and any paid provider campaign need separate authorization; this
change does not authorize HU74, a release or promotion to latest.
