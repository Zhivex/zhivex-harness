# Branch preparation — Core / CLI / Electron

Local review completed on November 15, 2026, before creating delivery branch
`feat/unify-core-cli-electron`. The validation results below describe the prepared candidate.

## Evidence cleanup

- Preserved 503 original files (22,772,080 bytes) in seven ZIPs plus a per-file
  SHA-256 manifest on the [private Notion archive](https://app.notion.com/p/41a777b104f681779666e4f1e75e0409).
  All ZIP entries match the original sizes and hashes, and independent local copies
  remain under ignored `.local-docs/branch-preparation-2026-11-15/`.
- Removed internal unification/UX reports, 149 PNG captures, five prototype JPEGs,
  obsolete planning documents and stage-zero inventory tools from the publishable
  tree. See the [archive index](../INTERNAL_ARCHIVE.md) for scope and recovery.
- Retained technical benchmark reports, unsuccessful campaigns and source snapshots
  bound to their manifests. No benchmark outcomes were removed or relabeled.
- Preserved the exact CLI inventory at `fixtures/cli-compatibility/inventory.json`;
  parity and compatibility smoke output now goes to ignored `results/unification/`.
- Normalized one older report's `evidencePath` to a repository-relative pointer.
  No remaining report contains `/Users/` or `/home/` paths. The candidate file scan
  found no exact matches for configured environment secrets. This is a bounded
  scan, not a claim that arbitrary secret formats can never occur.
- The only remaining new PNG files are three application assets. ZIPs, raw UI
  archives, local backups, generated reports and private environment files are
  excluded from ordinary Git staging.

## Corrections made while preparing the branch

- Fixed obsolete Desktop paths and links, including references inside published
  guides. The runtime package contains the migration and archive notices, while
  repository-only campaign reports remain outside it.
- Updated the compatibility smoke to expect the actual retired-web exit code and
  migration message.
- Reviewed the Stable API drift: only the optional `readAttempts` diagnostics field
  changes the closures for `runHarness` and `HarnessRunOptions`. Removing that field
  from a temporary declaration copy reproduced the previous snapshot digest exactly.
  Regenerated the reviewed snapshot and documented the additive change in Changelog.
- Kept `.env.*` ignored with `.env.example` available for contributors.

## Current validation

| Check | Result |
| --- | --- |
| Core + Electron suite | 2,738 passed; 1 platform skip; 0 failures; 367 files |
| CLI suite | 171 passed; 0 failures |
| Core build/declarations, tooling/CLI/Electron types | Passed |
| Workspaces, architecture, documentation and Stable contracts | Passed |
| Release metadata with `--allow-unreleased` | Passed |
| Historical migrations | 0.10.0 and 0.11.1 fixtures passed |
| CLI parity | 330 entries; no missing entries |
| Installed CLI compatibility smoke | Passed; retired web interface correctly rejected |
| Exact final tarball content and Markdown links | Passed; 659 files |
| Installed-package smoke on that exact tarball | Passed |
| Whitespace review | Source cleaned; two hash-bound historical snapshots retain their original blank line at EOF |
| Source drift during validation | None |

Local logs use the `/tmp/zhivex-prebranch-` prefix; the final archive is
`/tmp/zhivex-prebranch-final.tgz`. These temporary logs are not repository evidence.

## Next step

The evidence classification and local cleanup are complete. Create the new `feat/…`
branch, review the staged diff including new files, and commit the source migration,
context changes and documentation/evidence cleanup in coherent groups. Opening a PR
triggers the primary CI workflow; a push to a new branch alone does not.

Local checks do not certify the whole Linux/macOS CI matrix, live external accounts
or production Electron distribution. Developer ID signing, notarization and signed
updates remain separate release gates; the production feed stays disabled.
