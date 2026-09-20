# HU32 — reviewed pull-request manager, in progress

This increment implements host-side PR review, creation and reconciliation plus a
GitHub REST adapter. It is not yet exposed through main/preload/UI and has no new
packaged PR user journey. All three full HU32 criteria remain open.

Review captures title, exact body, draft choice, repository URL, base/head refs,
remote SHA/base SHA and complete commit/file history relative to the remote base.
The head must already be published, staged changes are refused, and the existing
secret/path/preview bounds apply. The Git transport now exposes a base-relative PR
inspection without changing the normal push range. Existing open PRs for the same
repository/head/base prevent another creation; other repositories are excluded.

A five-minute one-use review is revalidated before admission. The private operation
record is fsynced before the single POST. It stores proposal fingerprints and known
PR numbers, not title/body copies. A lost response searches open and closed PRs for
one new matching proposal, excluding historical IDs. Repeated accepted IDs and
restart only reconcile; they never send another create request. An uncertain or
unavailable result remains pending. A definitive API rejection is recorded and can
be followed by a new explicit review after correction, while retrying the rejected
ID does not POST again.

If the branch or base advances during creation, the returned PR is retained as
needs-review with both expected and observed SHAs. The manager neither silently
approves the changed contents nor creates a replacement. Confirmation records are
historical evidence of that operation, not a claim that the PR is still open or
unchanged. Old closed PRs do not masquerade as the newly requested PR; newly created
closed PRs can still reconcile a lost response without reopening or duplicating.

The GitHub adapter uses explicit same-repository REST endpoints via the host's gh
session. Request JSON travels on stdin, so body text such as @paths, shell syntax
and CLI placeholders stays literal. HTTP response headers distinguish definite
400/401/403/404/422 rejection from ambiguous network/server failures. Credentials
remain in gh; raw error output is not sent to the renderer. Listing is scoped to
head/base and bounded to ten pages of 100 items; mismatched repository/ref/URL
responses are rejected. Cross-repository PRs and live auth are not certified here.

Validation: 14 tests passed, zero failures and 106 assertions across PR manager,
GitHub API adapter, push manager and Git transport tests. Desktop typecheck passes.
Tests cover lost responses, restart, known/existing PRs, stale publication/base,
creation races, unknown outcomes without replay, definitive rejection followed by
new review, multiline secrets, protected history, closed-PR reconciliation, exact
stdin JSON, HTTP status classification, foreign-repository exclusion and unchanged
push behavior. The Git transport inspection uses real local Git objects; GitHub
API calls are intercepted by a local gh fixture. No real PR, GitHub POST or push of
`feat/harness-desktop` was performed.

Remaining: main/preload/UI review and authorization, runtime/shutdown coordination,
opening verified PR links, packaged creation/recovery/conflict journeys and the
final HU32 acceptance audit. Concurrent formatting changes observed in other
workspace files are preserved outside this increment's commit.

Primary API references checked during implementation:

- [GitHub pull request REST endpoints](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)
- [GitHub CLI gh api: input bodies and HTTP headers](https://cli.github.com/manual/gh_api)
