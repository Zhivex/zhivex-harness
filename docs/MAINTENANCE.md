# Maintenance and release

These documents are for contributors, release operators and reviewers. For product
usage, start with [First use](FIRST_USE.md).

## Build and design

- [Contributing](../CONTRIBUTING.md) and [roadmap](../ROADMAP.md).
- [Console UX rationale](CLI_UX.md).
- [Desktop development](../desktop/DEVELOPMENT.md) and [architecture](DESKTOP_ARCHITECTURE.md).

## Release and evidence

- [Release procedure](RELEASE.md) and [rollback](ROLLBACK.md).
- [Live certification](LIVE_CERTIFICATION.md) and [GA readiness](GA_READINESS.md).
- [Security review requirements](SECURITY_REVIEW_EVIDENCE.md).
- [RC14 delegated review decision](RC14_DELEGATED_SECURITY_DECISION.md).
- [Gemini support decision](GEMINI_1_0_DECISION.md).

## Evaluation and history

- [Hostile repository demo](HOSTILE_REPOSITORY_DEMO.md).
- [Benchmark guide](../benchmarks/README.md) and [Time-to-Safe-Fix protocol](TIME_TO_SAFE_FIX.md).
- [Historical reports](reports/README.md) and [local results](../results/README.md).

Failed attempts and historical findings remain available. They do not describe
later releases automatically.

## Documentation policy

Use English for maintained product and contributor guides. Keep one authoritative
page per topic and link to it. Any future translations should mirror complete guides
in a separate language directory. Preserve historical reports in their original language.

Keep the root README focused on installation, the first task, product choices and
material limitations. Put scripts and API contracts in integration references;
put build, test, certification and release procedures in contributor documentation.
The npm manifest lists included guides explicitly. When changing it, validate the
packed artifact and every relative Markdown link inside it.
