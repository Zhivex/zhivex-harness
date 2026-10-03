# Code 0.2.0 release preparation

## Scope and publication boundary

Prepared from main `9aaaef794586da02960c820accf33638b757bc9f`, after PR157 and
PR158 merged. Code becomes `0.2.0` and keeps the exact published
`@zhivex-ai/harness@1.3.0` dependency. Harness stays at `1.3.0`; no Chat or SDK
source changes, paid provider calls, tags, publication, deployment or access
changes are part of this preparation. Code `0.1.0` remains the verified `latest`
release. Publication requires separate maintainer approval.

The candidate exposes PR158's guided diffs, reviewed checkpoints, per-run
estimated budgets and offline tutorial. Approval and digest checks remain owned
by the engine. Stale or partial restore operations remain rejected; the UI never
refreshes preconditions automatically. Estimates are not invoices or guaranteed
financial caps. Provider support and API stability tiers remain unchanged.

## Packaging regression and correction

Before correction, a real Bun-packed Code tarball and a deterministic minimal
tarball test both failed release inspection with
`Unexpected Code payload: package/examples/first-use.mjs`. The manifest shipped
the examples, while the validator admitted only metadata and flat built JS.
The failed test was recorded before changing the allowlist (8 passed, 1 failed).

Code's manifest now names `examples/first-use.mjs` and
`examples/offline-provider.mjs` explicitly and includes its own changelog.
Inspection admits those exact paths, required metadata and flat built JS only.
It rejects arbitrary examples, source files, secrets, nested output, traversal,
duplicate entries and links. Required files, the exact checked-out manifest,
the Node shebang and the SHA-512 of the complete tarball are verified.

## Exact-source and retained-artifact gates

`code-release.ts identity` requires the latest successful main push runs of
`ci.yml`, `codeql.yml` and `code-journey.yml` for the selected full commit SHA.
Journeys run for every PR and main push, with Linux/macOS and Node 22.13.0/24.
Code dependency installation uses the checked-in frozen lockfile.

The journey driver accepts an existing tarball, installs it with npm and the
published Harness dependency without overrides or lifecycle scripts, and runs
offline PTY scenarios for approvals, denial, pending restart/resume, check
receipts, budgets/unknown cost, checkpoint restore/stale retry, cancellation
and continuation. It retains the exact tested tarball, source SHA, Node version,
byte count, SHA-512 and transcript. The protected release workflow invokes that
driver on its already packed `code.tgz`, preserving the bytes for publication.
Synthetic transport responses and prices are offline fixtures, not live provider
certification. This Code-only release does not require a new paid six-provider
Harness campaign.

## Validation and handoff

Local validation passed the 108 Code tests and the 12 release-validator tests,
architecture/documentation/contract gates, root/tooling/Code type checks,
independent Code build, frozen lockfile installation, dependency audits and
the installed offline PTY. The public Harness 1.3.0 tarball was downloaded with
verified registry integrity and source-bound provenance; standalone registry
resolution and the read-only Code registry gate passed (`0.2.0` absent).

The inspected local Code tarball contains 12 regular files and 84,688 bytes.
Its SHA-512 is
`53410405a0e6dccf06a36fc69184283d146c369252f584a3c672017e1915f8109ae701c54fec038c2d6afe60443f00d5420f434eaff58679b86ea16174bc069e`.
The installed driver verified the same bytes after testing. These local bytes
are preparation evidence; the protected workflow must build and retain its own
release artifact and provenance.

The broader local Harness test run recorded 1,722 passed, 9 skipped, 8 failed
and 2 secondary errors. Unchanged credential-mode tests encounter the cloud
shell's `0077` umask; unchanged host-policy tests see the sandbox's synthetic
`/tmp/.git` and reject sibling policy fixtures; two Bun command checks reach
the existing five-second test timeout. Those results are retained as failed
local attempts, not reported as a successful full suite. The supported GitHub
CI runs determine full-suite acceptance without changing Harness code or
weakening its tests for this Code-only preparation.

Local consumer reports and exact-commit remote results are recorded in the draft PR.
The first remote attempt passed CodeQL, all four Code journeys, installed
consumers and the complete Linux/macOS unit suites (1,906 and 1,926 passed,
zero failed). Its final Harness artifact check rejected relative links added
by this preparation to Code documents excluded from the Harness tarball.
Those references now use source-repository URLs; the corrected local Harness
artifact passed its 322-file validation. The final PR SHA requires its own
terminal CI, CodeQL and journey results; earlier successes are not reused.

Successful PR checks do not authorize publication or substitute for main push
checks after merge. The release operator must:

1. Obtain review and merge the preparation PR.
2. Wait for CI, CodeQL and all four installed journeys on the exact main SHA.
3. Obtain separate approval to create the annotated `code-v0.2.0` tag and
   dispatch the existing protected Code workflow with `channel=latest` and OIDC.
4. Publish only its retained, inspected, PTY-tested artifact after the protected
   environment approval, then verify registry bytes, `latest` and provenance.

The existing [Code release procedure](../CODE_RELEASE.md) is authoritative.
