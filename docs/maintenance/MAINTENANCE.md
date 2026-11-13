# Maintenance and release

These documents are for contributors, release operators and reviewers. For product
usage, start with [First use](../getting-started/FIRST_USE.md).

## Build and design

- [Contributing](../../CONTRIBUTING.md) and [roadmap](../../ROADMAP.md).
- [Console UX rationale](../cli/CLI_UX.md).
- [Desktop development](../../desktop/DEVELOPMENT.md) and [architecture](../reports/DESKTOP_ARCHITECTURE.md).
- [Gradual Code-to-Assistant migration](../plans/CODE_TO_ASSISTANT_MIGRATION.md).

## Release and evidence

- [Release procedure](RELEASE.md) and [rollback](ROLLBACK.md).
- [Historical release preparations and decisions](../reports/RELEASE_HISTORY_THROUGH_1_6_2.md).
- [Live certification](LIVE_CERTIFICATION.md) and [GA readiness](GA_READINESS.md).
- [Security review requirements](../security/SECURITY_REVIEW_EVIDENCE.md).
- [RC14 delegated review decision](../security/RC14_DELEGATED_SECURITY_DECISION.md).
- [Gemini support decision](../reports/GEMINI_1_0_DECISION.md).

## Evaluation and history

- [Common task acceptance](TASK_ACCEPTANCE.md): exact tarball, fixed fixtures, attempts and independent verification.
- [Hostile repository demo](../getting-started/HOSTILE_REPOSITORY_DEMO.md).
- [Benchmark guide](../../benchmarks/README.md) and [Time-to-Safe-Fix protocol](TIME_TO_SAFE_FIX.md).
- [Historical reports](../reports/README.md) and [local results](../../results/README.md).

Failed attempts and historical findings remain available. They do not describe
later releases automatically.

## Documentation policy

Use English for repository documentation, including product guides, contributor guides,
READMEs and historical reports. Keep one authoritative page per topic and link to it.
Any future translations should mirror complete guides in a separate language directory.
When translating historical reports, preserve their findings, measurements, artifact
identities, evidence links and limitations. Identify translated verbatim quotations as translations.

Keep the root README focused on installation, the first task, product choices and
material limitations. Put scripts and API contracts in integration references;
put build, test, certification and release procedures in contributor documentation.
The npm manifest lists included guides explicitly. When changing it, validate the
packed artifact and every relative Markdown link inside it.

### Topic directories and historical records

Keep `docs/README.md` as the only Markdown file directly under `docs/`. Place
usage guides in `getting-started/`, `assistant/` or `cli/`; integration contracts
in `architecture/`; provider setup in `providers/`; security policy in `security/`;
and contributor procedures in `maintenance/`. Proposed work belongs in `plans/`,
decisions in `adr/`, and dated implementation/validation snapshots in `reports/`.

Consolidate related snapshots into a report with stable section anchors instead
of growing a file per implementation step. Preserve each snapshot's outcomes,
failed attempts, versions and scope; do not turn historical instructions into
current guidance. Link to the maintained guide from the archive.

When relocating documentation, update repository references, structured paths in
scripts/tests, manifest allowlists and the [path map](../path-map.json). Preserve
commit-pinned URLs and source-path/hash bindings in immutable JSON run evidence.
Validate with `bun run docs:check`, documentation/release regression tests and
`bun run artifact:check -- /path/to/candidate.tgz` on an actual local tarball.
Do not publish a package merely to verify documentation changes.
